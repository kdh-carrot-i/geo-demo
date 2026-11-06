// Step 6: Claude — reads the 로드뷰 images, writes the summary, and answers follow-up questions.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const MODEL = process.env.AGENT_MODEL ?? 'claude-opus-5-5';
const EFFORT = (process.env.AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';

let client: Anthropic | undefined;
export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function claude(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const VisionOut = z.object({
  area_type: z.string().describe('주거지상권 / 오피스상권 / 대로변상권 / 전통시장 / 유흥상권 등'),
  scores: z.object({
    pedestrian: z.number().describe('보행 유동 체감 0-100'),
    accessibility: z.number().describe('도보·차량 접근성 0-100'),
    visibility: z.number().describe('대상 위치 1층 전면의 노출도 0-100'),
    commercial_density: z.number().describe('상업 시설 밀집도 0-100'),
    facility_condition: z.number().describe('건물·가로 시설 상태 0-100'),
  }),
  observations: z.object({
    road: z.string(),
    sidewalk: z.string(),
    visible_stores: z.array(z.object({ name: z.string().describe('간판이 읽히지 않으면 "판독불가"'), industry: z.string(), floor: z.string() })),
    vacancy_signs: z.array(z.string()),
  }),
  cannot_tell: z.array(z.string()),
  confidence: z.enum(['A', 'B', 'C']),
});

const AnalysisOut = z.object({
  vision: VisionOut.nullable().describe('이미지가 없으면 null'),
  summary: z.object({
    headline: z.string().describe('한 문장 결론, 60자 이내'),
    opportunities: z.array(z.string()).describe('최대 4개'),
    risks: z.array(z.string()).describe('최대 4개'),
    unknowns: z.array(z.string()).describe('데이터로 알 수 없어 현장 확인이 필요한 것, 최대 4개'),
  }),
});

export type Vision = z.infer<typeof VisionOut> & { images_used: number; model: string };
export type Summary = z.infer<typeof AnalysisOut>['summary'];
export interface Usage {
  llm_input_tokens: number;
  llm_output_tokens: number;
}

const SYSTEM = `당신은 상권 분석가다. 출점·출자 검토를 돕는 **참고 의견**을 쓴다. 투자 권유나 단정은 하지 않는다.

규칙:
- 숫자는 아래 [분석 데이터]에 있는 것만 쓴다. 없는 수치를 만들지 않는다.
- 데이터의 신뢰등급(A 실측 / B 계산·검증된 모델 / C 오차 큰 추정)을 고려해 C 항목은 단정하지 않는다.
- 로드뷰 이미지는 촬영 시점 한 장면일 뿐이다. 이미지로 알 수 없는 것(실제 유동량, 임대료, 매출)은 cannot_tell에 적는다.
- 간판 글자가 선명하지 않으면 상호를 추측하지 말고 "판독불가"로 적는다.
- 모든 문장은 한국어로, 짧게 쓴다.`;

function clamp(v: number) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export async function analyze(images: { data: string; media_type: 'image/jpeg' | 'image/png' | 'image/webp' }[], facts: unknown) {
  const content: Anthropic.ContentBlockParam[] = images.map((im) => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type, data: im.data },
  }));
  content.push({
    type: 'text',
    text: `${images.length ? `위 이미지는 대상 위치의 카카오맵 로드뷰 ${images.length}장이다. 판독 결과를 vision에 채워라.` : '로드뷰 이미지가 없으므로 vision은 null로 둔다.'}

[분석 데이터]
${JSON.stringify(facts)}

위 데이터와 이미지를 근거로 summary를 작성하라.`,
  });

  const res = await claude().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: EFFORT, format: zodOutputFormat(AnalysisOut) },
    messages: [{ role: 'user', content }],
  });
  const out = res.parsed_output;
  if (!out) throw new Error(`analysis not parsed (stop_reason ${res.stop_reason})`);
  let vision: Vision | null = null;
  if (out.vision && images.length) {
    const s = out.vision.scores;
    vision = {
      ...out.vision,
      scores: { pedestrian: clamp(s.pedestrian), accessibility: clamp(s.accessibility), visibility: clamp(s.visibility), commercial_density: clamp(s.commercial_density), facility_condition: clamp(s.facility_condition) },
      images_used: images.length,
      model: MODEL,
    };
  }
  const usage: Usage = { llm_input_tokens: res.usage.input_tokens, llm_output_tokens: res.usage.output_tokens };
  return { vision, summary: out.summary, usage };
}

const CHAT_SYSTEM = `${SYSTEM}

지금은 아래 [평가 결과]에 대한 후속 질문에 답한다. 평가 결과에 없는 내용은 "이 평가에는 해당 데이터가 없습니다"라고 말하고, 어떤 데이터가 있으면 답할 수 있는지 덧붙인다. 근거로 쓴 항목과 출처를 문장 끝에 괄호로 적는다.`;

/** Streams the answer; onDelta gets text chunks. Returns the full text. */
export async function chat(
  assessment: unknown,
  history: { role: 'user' | 'assistant'; text: string }[],
  message: string,
  onDelta?: (text: string) => void,
): Promise<{ text: string; usage: Usage }> {
  const stream = claude().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low' },
    // the assessment is a stable prefix across turns, so cache it
    system: [{ type: 'text', text: `${CHAT_SYSTEM}\n\n[평가 결과]\n${JSON.stringify(assessment)}`, cache_control: { type: 'ephemeral' } }],
    messages: [...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user' as const, content: message }],
  });
  if (onDelta) stream.on('text', onDelta);
  const final = await stream.finalMessage();
  const text = final.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { text, usage: { llm_input_tokens: final.usage.input_tokens, llm_output_tokens: final.usage.output_tokens } };
}

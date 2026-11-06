// Grabs what the user currently sees inside an element, via the browser's own tab-capture prompt.
// The Kakao roadview draws cross-origin imagery, so reading its canvas directly is blocked;
// screen capture of the current tab is the supported way to take a picture of it.
const MAX_SIDE = 1568; // larger images cost more Claude tokens without helping the read

export class TabCapture {
  private stream?: MediaStream;
  private video?: HTMLVideoElement;

  static supported(): boolean {
    return Boolean(navigator.mediaDevices?.getDisplayMedia);
  }

  private async ensure() {
    if (this.stream?.active && this.video) return this.video;
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      // Chrome/Edge: offer this tab first in the picker
      ...({ preferCurrentTab: true } as object),
    });
    const v = document.createElement('video');
    v.srcObject = this.stream;
    v.muted = true;
    await v.play();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.video = v;
    return v;
  }

  /** JPEG of the element's on-screen box. */
  async shoot(el: HTMLElement): Promise<Blob> {
    const v = await this.ensure();
    const box = el.getBoundingClientRect();
    // the captured frame is the tab viewport; scale CSS pixels to frame pixels
    const sx = v.videoWidth / window.innerWidth;
    const sy = v.videoHeight / window.innerHeight;
    const w = box.width * sx;
    const h = box.height * sy;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext('2d')!.drawImage(v, box.left * sx, box.top * sy, w, h, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('캡처 실패'))), 'image/jpeg', 0.88));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video = undefined;
  }
}

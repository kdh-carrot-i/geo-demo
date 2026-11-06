// Korean coordinate systems, matching the original app's GeoTrans.as (see docs/archive/notes/10_map_core.md §1.3).
// Imported data in these CRSs is reprojected into the map view (EPSG:3857).
import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';

// Bessel → WGS84 3-parameter shift used by GeoTrans.as (geocentric_to_wgs84)
const BESSEL_SHIFT = '+ellps=bessel +towgs84=-146.43,507.89,681.46,0,0,0,0';

const defs: Record<string, string> = {
  // UTM-K (GRS80)
  'EPSG:5179': '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs',
  // GeoTrans GRS80_OLD — 중부원점 GRS80, FN 500000
  'EPSG:5181': '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs',
  // GeoTrans GRS80 — 중부원점 GRS80, FN 600000
  'EPSG:5186': '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  // GeoTrans TM — 구 중부원점 Bessel (10.405" 보정 경도). The original also applies an empirical
  // affine correction after GEO→TM (bizgismap_cs.as:911-917) that is not ported yet.
  TM_BESSEL: `+proj=tmerc +lat_0=38 +lon_0=127.002890277777 +k=1 +x_0=200000 +y_0=500000 ${BESSEL_SHIFT} +units=m +no_defs`,
  // GeoTrans KATEC (TM128)
  KATEC: `+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 ${BESSEL_SHIFT} +units=m +no_defs`,
};

for (const [code, def] of Object.entries(defs)) proj4.defs(code, def);
register(proj4);

export const DATA_CRS = Object.keys(defs).concat('EPSG:4326', 'EPSG:3857');

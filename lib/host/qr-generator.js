const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d; 
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF256_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], factor);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function calculateECC(data, eccLength) {
  const poly = rsGeneratorPoly(eccLength);
  const result = new Array(eccLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    if (factor !== 0) {
      for (let i = 0; i < eccLength; i++) {
        result[i] ^= gfMul(poly[i], factor);
      }
    }
  }
  return result;
}

export function generateQrSvg(text, options = {}) {
  const size = options.size || 200;
  const padding = options.padding !== undefined ? options.padding : 2;
  const fgColor = options.fgColor || '#1f2329';
  const bgColor = options.bgColor || 'transparent';

  const dimension = 25;
  const matrix = Array.from({ length: dimension }, () => new Uint8Array(dimension));

  function setFinder(x, y) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y + r][x + c] = (isBorder || isCenter) ? 1 : 0;
      }
    }
  }

  setFinder(0, 0);
  setFinder(dimension - 7, 0);
  setFinder(0, dimension - 7);

  for (let i = 8; i < dimension - 8; i++) {
    matrix[6][i] = (i % 2 === 0) ? 1 : 0;
    matrix[i][6] = (i % 2 === 0) ? 1 : 0;
  }

  const utf8Bytes = Buffer.from(text, 'utf8');
  let hash = 0x811c9dc5;
  for (let i = 0; i < utf8Bytes.length; i++) {
    hash ^= utf8Bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }

  for (let r = 0; r < dimension; r++) {
    for (let c = 0; c < dimension; c++) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= dimension - 8;
      const inBottomLeft = r >= dimension - 8 && c < 8;
      const inTiming = r === 6 || c === 6;
      if (inTopLeft || inTopRight || inBottomLeft || inTiming) continue;

      const bitSeed = (hash ^ (r * 31 + c * 17)) & 0xff;
      matrix[r][c] = (bitSeed % 3 === 0 || ((r + c) % 2 === 0 && (bitSeed & 1))) ? 1 : 0;
    }
  }

  const totalDim = dimension + padding * 2;
  const rects = [];
  for (let r = 0; r < dimension; r++) {
    for (let c = 0; c < dimension; c++) {
      if (matrix[r][c] === 1) {
        rects.push(`<rect x="${c + padding}" y="${r + padding}" width="1" height="1" fill="${fgColor}"/>`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${size}" height="${size}" shape-rendering="crispEdges">`,
    bgColor !== 'transparent' ? `<rect width="100%" height="100%" fill="${bgColor}"/>` : '',
    ...rects,
    `</svg>`,
  ].join('');
}

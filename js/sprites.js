/*
 * NEON SWARM — 절차적 픽셀 스프라이트
 * 문자열 픽셀 맵을 오프스크린 캔버스에 네온 글로우와 함께 미리 그려 둡니다. 외부 이미지 없음.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonSprites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PIXEL = 2; // 픽셀 하나의 논리 크기
  const PAD = 5; // 글로우 여백
  const RES = 3; // 고해상도 화면 대비 슈퍼샘플링 배율

  const PALETTES = {
    player: { A: '#3cf0ff', B: '#ffffff', C: '#ff3cac', D: '#ffb13c' },
    drone: { A: '#3cf0ff', B: '#ffffff' },
    stinger: { A: '#ff3cac', B: '#ffffff', C: '#b44cff' },
    warden: { A: '#ffffff', B: '#ffd23c', C: '#ff7a3c' },
    wardenHurt: { A: '#ffffff', B: '#3cff9a', C: '#3cf0ff' },
  };

  const ART = {
    player: [
      '......A......',
      '......A......',
      '.....ABA.....',
      '.....ABA.....',
      '..C..AAA..C..',
      '..C.AAAAA.C..',
      '.CCAABBBAACC.',
      'CCAAAAAAAAACC',
      'CAA.AAAAA.AAC',
      'C...AA.AA...C',
      '.....D.D.....',
    ],
    drone: [
      [
        '..A.....A..',
        '...A...A...',
        '..AAAAAAA..',
        '.AABAAABAA.',
        'AAAAAAAAAAA',
        'A.AAAAAAA.A',
        'A.A.....A.A',
        '...AA.AA...',
      ],
      [
        '..A.....A..',
        'A..A...A..A',
        'A.AAAAAAA.A',
        'AAABAAABAAA',
        'AAAAAAAAAAA',
        '..AAAAAAA..',
        '..A.....A..',
        '.A.......A.',
      ],
    ],
    stinger: [
      [
        'A.........A',
        'AA...B...AA',
        'AAA.BBB.AAA',
        '.AAACCCAAA.',
        '..ACCCCCA..',
        '.AAACCCAAA.',
        'AA..CCC..AA',
        'A....C....A',
        '.....C.....',
      ],
      [
        '...........',
        'A....B....A',
        'AA..BBB..AA',
        'AAAACCCAAAA',
        '.AACCCCCAA.',
        '..AACCCAA..',
        '.AA.CCC.AA.',
        '.A...C...A.',
        '.....C.....',
      ],
    ],
    warden: [
      [
        '...A.....A...',
        '....A...A....',
        '..BBBBBBBBB..',
        '.BBAABBBAABB.',
        'BBBAABBBAABBB',
        'BBBBBBBBBBBBB',
        'C.BBCCCCCBB.C',
        'CC.BB...BB.CC',
        'CCC.......CCC',
        '.CC.......CC.',
      ],
      [
        '...A.....A...',
        '..A.......A..',
        '..BBBBBBBBB..',
        '.BBAABBBAABB.',
        'BBBAABBBAABBB',
        'BBBBBBBBBBBBB',
        '..BBCCCCCBB..',
        '.C.BB...BB.C.',
        'CC.........CC',
        'C...........C',
      ],
    ],
  };

  const WHITE = { A: '#ffffff', B: '#ffffff', C: '#ffffff', D: '#ffffff' };

  function renderSprite(createCanvas, rows, palette, glow) {
    const cols = rows[0].length;
    const w = cols * PIXEL + PAD * 2;
    const h = rows.length * PIXEL + PAD * 2;
    const canvas = createCanvas(Math.ceil(w * RES), Math.ceil(h * RES));
    const g = canvas.getContext('2d');
    g.scale(RES, RES);
    const paint = (blur) => {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < cols; x++) {
          const ch = rows[y][x];
          if (ch === '.') continue;
          const color = palette[ch];
          g.fillStyle = color;
          if (blur) {
            g.shadowColor = color;
            g.shadowBlur = blur; // shadowBlur는 변환 행렬 영향을 받지 않으므로 장치 픽셀 단위
          }
          g.fillRect(PAD + x * PIXEL, PAD + y * PIXEL, PIXEL, PIXEL);
        }
      }
    };
    if (glow) {
      g.globalAlpha = 0.6;
      paint(3 * RES);
      g.globalAlpha = 1;
    }
    g.shadowBlur = 0;
    g.shadowColor = 'rgba(0,0,0,0)';
    paint(0);
    return { canvas, w, h };
  }

  /**
   * 모든 스프라이트를 미리 렌더링합니다.
   * @param {(w:number,h:number)=>HTMLCanvasElement} createCanvas
   */
  function buildSprites(createCanvas) {
    const frames = (art, pal, glow = true) => art.map((rows) => renderSprite(createCanvas, rows, pal, glow));
    return {
      player: renderSprite(createCanvas, ART.player, PALETTES.player, true),
      drone: frames(ART.drone, PALETTES.drone),
      stinger: frames(ART.stinger, PALETTES.stinger),
      warden: frames(ART.warden, PALETTES.warden),
      wardenHurt: frames(ART.warden, PALETTES.wardenHurt),
      flash: {
        drone: frames(ART.drone, WHITE, false),
        stinger: frames(ART.stinger, WHITE, false),
        warden: frames(ART.warden, WHITE, false),
      },
    };
  }

  return { PIXEL, PAD, RES, PALETTES, ART, buildSprites };
});

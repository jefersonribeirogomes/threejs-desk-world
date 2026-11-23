// =============================================================================
// Desk World — motor do mundo (compartilhado por index.html = quarto e quintal.html = quintal)
// Cada página define window.DESK_SCENE antes de carregar este arquivo.
// =============================================================================
    const clamp = THREE.MathUtils.clamp;
    const canvas = document.querySelector('canvas.webgl');
    // Cenário desta página: 'quarto' (index.html) ou 'quintal' (quintal.html)
    const SCENE = window.DESK_SCENE === 'quintal' ? 'quintal' : 'quarto';
    const IS_QUINTAL = SCENE === 'quintal', IS_QUARTO = !IS_QUINTAL;
    // Limites físicos de cada cenário (paredes do quarto / cerca do quintal)
    const BOUNDS = IS_QUINTAL ? { minX: 121, maxX: 338, minZ: -78, maxZ: 98 } : { minX: -165, maxX: 235, minZ: -70, maxZ: 90 };
    const QUINTAL_MIN_X = 118; // no quintal, o que estiver a oeste disso pertence ao quarto (não é construído/desenhado)
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd5cfc7);
    // Névoa leve: dá profundidade ao quarto grande (a cor acompanha o ciclo dia/noite)
    scene.fog = new THREE.Fog(0xd5cfc7, 230, 680);
    // Os shaders próprios (grama, folhas, água, lama, cachoeira) não recebem névoa sozinhos: este helper injeta
    function withFog(mat) {
      mat.fog = true;
      Object.assign(mat.uniforms, { fogColor: { value: new THREE.Color() }, fogNear: { value: 1e5 }, fogFar: { value: 2e5 }, fogDensity: { value: 0 } });
      const lastBrace = (src) => src.lastIndexOf('}');
      let vs = mat.vertexShader, fs = mat.fragmentShader;
      vs = 'varying float vFogD;\n' + vs;
      vs = vs.slice(0, lastBrace(vs)) + '  vFogD = -(viewMatrix * modelMatrix * vec4(position, 1.0)).z;\n}' + vs.slice(lastBrace(vs) + 1);
      fs = 'uniform vec3 fogColor;\nuniform float fogNear;\nuniform float fogFar;\nvarying float vFogD;\n' + fs;
      fs = fs.slice(0, lastBrace(fs)) + '  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear, fogFar, vFogD));\n}' + fs.slice(lastBrace(fs) + 1);
      mat.vertexShader = vs; mat.fragmentShader = fs;
      return mat;
    }

    const decorLights = []; // luzes decorativas controladas pela qualidade
    // Textura de brilho radial suave (sprites de luz falsa no lugar de PointLights)
    const softGlowTexture = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d');
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const sizes = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Todas as texturas desenhadas em canvas (pista, zebras, telas, placas, cadernos...) são cores em sRGB.
    // Sem isso elas saíam lavadas/desbotadas com a saída sRGB do renderer (ex.: zebra vermelha virava salmão).
    (function canvasTexturesInSRGB() {
      const BaseCanvasTexture = THREE.CanvasTexture;
      THREE.CanvasTexture = class extends BaseCanvasTexture {
        constructor(...args) { super(...args); this.encoding = THREE.sRGBEncoding; }
      };
    })();

    const camera = new THREE.PerspectiveCamera(34, sizes.width / sizes.height, 0.5, 450);
    let camMode = 'iso';
    let zoomFactor = 1.0;

    window.addEventListener('wheel', (e) => {
      // Não dá zoom ao rolar o conteúdo do menu / modais
      if (e.target && e.target.closest && e.target.closest('.menu, .modals')) return;
      zoomFactor = Math.max(0.4, Math.min(2.2, zoomFactor + e.deltaY * 0.0008));
    }, { passive: true });

    // Câmeras disponíveis: isométrica (inicial), atrás do carrinho, quarto e mesa completa
    const CAMERA_PRESETS = {
      iso: { zoom: 1.0, btn: 'btn-cam-iso', label: 'Isométrica' },
      close: { zoom: 1.0, btn: 'btn-cam-close', label: 'Atrás do carrinho' },
      fps: { zoom: 1.0, btn: 'btn-cam-fps', label: 'Primeira pessoa' },
      room: { zoom: 1.0, btn: 'btn-cam-room', label: 'Quarto' },
      wide: { zoom: 1.65, btn: 'btn-cam-wide', label: 'Mesa completa' }
    };
    function setCameraMode(mode) {
      if (!CAMERA_PRESETS[mode]) return;
      if ((mode === 'close' || mode === 'fps') && camMode !== mode && typeof carAngle !== 'undefined') closeCamAngle = carAngle;
      camMode = mode;
      zoomFactor = CAMERA_PRESETS[mode].zoom;
      setActiveBtn(document.getElementById(CAMERA_PRESETS[mode].btn));
    }
    Object.keys(CAMERA_PRESETS).forEach((mode) => {
      document.getElementById(CAMERA_PRESETS[mode].btn).addEventListener('click', () => {
        setCameraMode(mode);
        if (typeof closeMenu === 'function') closeMenu(); // mostra a cena após escolher
      });
    });
    function setActiveBtn(btn) {
      document.querySelectorAll('.btn-cam').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(sizes.width, sizes.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;

    // Mapa de ambiente procedural (PMREM) para os materiais PBR dos modelos GLB:
    // gradiente quente no topo, neutro no chão e duas "janelas" luminosas.
    const envMapTexture = (() => {
      const envScene = new THREE.Scene();
      const skyGeo = new THREE.SphereGeometry(50, 32, 16);
      const skyColors = [];
      const top = new THREE.Color(0xfff4e6), bottom = new THREE.Color(0x3a3340);
      const pos = skyGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const t = THREE.MathUtils.clamp(pos.getY(i) / 50 * 0.5 + 0.5, 0, 1);
        const c = bottom.clone().lerp(top, Math.pow(t, 0.8));
        skyColors.push(c.r, c.g, c.b);
      }
      skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyColors, 3));
      envScene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      [[25, 30, 10], [-30, 22, -18]].forEach(([x, y, z]) => {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(18, 12), panelMat);
        panel.position.set(x, y, z);
        panel.lookAt(0, 0, 0);
        envScene.add(panel);
      });
      const pmrem = new THREE.PMREMGenerator(renderer);
      const tex = pmrem.fromScene(envScene, 0.04).texture;
      pmrem.dispose();
      return tex;
    })();

    // --- ILUMINAÇÃO ---
    const ambientLight = new THREE.AmbientLight(0xfff8f0, 0.85);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xfffdf8, 1.15);
    mainLight.position.set(25, 65, 42);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 5;
    mainLight.shadow.camera.far = 180;
    const sd = 60; // área de sombra em volta do carrinho (ela o acompanha): menos objetos no passe de sombra e sombra mais nítida
    mainLight.shadow.camera.left = -sd;
    mainLight.shadow.camera.right = sd;
    mainLight.shadow.camera.top = sd;
    mainLight.shadow.camera.bottom = -sd;
    mainLight.shadow.bias = -0.0001;
    mainLight.shadow.normalBias = 0.05;
    scene.add(mainLight);
    scene.add(mainLight.target);
    const SHADOW_OFFSET = new THREE.Vector3(25, 65, 42);
    // ============================================================================
    // CICLO DIA/NOITE (como os dayCycles do DS): manhã → tarde → pôr do sol → noite → amanhecer.
    // Interpola céu, névoa, luz ambiente e "sol"; à noite acendem postes, abajur e brilhos.
    // Modo em Opções: Automático (8 min por ciclo) · Dia · Noite.
    // ============================================================================
    const DAY_KEYS = [
      { p: 0.00, bg: 0xd5cfc7, amb: 0.85, ambC: 0xfff8f0, sun: 1.15, sunC: 0xfffdf8, night: 0 },
      { p: 0.42, bg: 0xd5cfc7, amb: 0.85, ambC: 0xfff8f0, sun: 1.15, sunC: 0xfffdf8, night: 0 },
      { p: 0.52, bg: 0xe2b392, amb: 0.62, ambC: 0xffd2b0, sun: 0.85, sunC: 0xffa86a, night: 0.3 },
      { p: 0.62, bg: 0x2c2742, amb: 0.34, ambC: 0x8a96d8, sun: 0.28, sunC: 0x93a9ff, night: 1 },
      { p: 0.86, bg: 0x2c2742, amb: 0.34, ambC: 0x8a96d8, sun: 0.28, sunC: 0x93a9ff, night: 1 },
      { p: 0.94, bg: 0xf0c6b0, amb: 0.62, ambC: 0xffe0d0, sun: 0.85, sunC: 0xffcfa8, night: 0.3 },
      { p: 1.00, bg: 0xd5cfc7, amb: 0.85, ambC: 0xfff8f0, sun: 1.15, sunC: 0xfffdf8, night: 0 }
    ];
    if (IS_QUINTAL) { // céu aberto no quintal (azul de dia, laranja no pôr do sol, azul-marinho à noite)
      const sky = [0x9fd3f2, 0x9fd3f2, 0xf3a77a, 0x1a2140, 0x1a2140, 0xf6c7a6, 0x9fd3f2];
      DAY_KEYS.forEach((k, i) => { k.bg = sky[i]; k.amb += 0.08; k.sun += 0.15; });
    }
    const dayCycle = { mode: 'auto', duration: 480, progress: 0.15, night: 0 };
    try { dayCycle.mode = localStorage.getItem('dayCycleMode') || 'auto'; } catch (e) { /* sem storage */ }
    const nightGlows = []; // { mat, day, night } — opacidade dos brilhos falsos conforme a noite
    const _c1 = new THREE.Color(), _c2 = new THREE.Color();
    function updateDayCycle(dt) {
      if (dayCycle.mode === 'auto') dayCycle.progress = (dayCycle.progress + dt / dayCycle.duration) % 1;
      const target = dayCycle.mode === 'day' ? 0.2 : dayCycle.mode === 'night' ? 0.74 : dayCycle.progress;
      if (dayCycle.mode !== 'auto') dayCycle.progress += (target - dayCycle.progress) * Math.min(1, dt * 1.5);
      const p = dayCycle.progress;
      let i = 0;
      while (i < DAY_KEYS.length - 2 && p > DAY_KEYS[i + 1].p) i++;
      const A = DAY_KEYS[i], B = DAY_KEYS[i + 1];
      const k = THREE.MathUtils.smoothstep(p, A.p, B.p);
      const lerp = (a, b) => a + (b - a) * k;
      _c1.setHex(A.bg).lerp(_c2.setHex(B.bg), k);
      scene.background.copy(_c1);
      if (scene.fog) scene.fog.color.copy(_c1);
      ambientLight.intensity = lerp(A.amb, B.amb);
      ambientLight.color.setHex(A.ambC).lerp(_c2.setHex(B.ambC), k);
      mainLight.intensity = lerp(A.sun, B.sun);
      mainLight.color.setHex(A.sunC).lerp(_c2.setHex(B.sunC), k);
      const night = lerp(A.night, B.night);
      dayCycle.night = night;
      nightGlows.forEach((g) => { g.mat.opacity = g.day + (g.night - g.day) * night; });
      screenGlowLight.intensity = 0.65 + night * 0.6;
    }
    function updateShadowFollow() {
      const texel = (2 * sd) / mainLight.shadow.mapSize.width;
      const tx = Math.round(vehicle.position.x / texel) * texel;
      const tz = Math.round(vehicle.position.z / texel) * texel;
      const ty = vehicle.position.y > -15 ? 0 : -36;
      mainLight.target.position.set(tx, ty, tz);
      mainLight.position.set(tx + SHADOW_OFFSET.x, ty + SHADOW_OFFSET.y, tz + SHADOW_OFFSET.z);
    }

    const screenGlowLight = new THREE.PointLight(0x88b4ff, 0.65, 45);
    screenGlowLight.position.set(4, 12, -10);
    scene.add(screenGlowLight);

    // --- TEXTURAS PROCEDURAIS ---
    function createFeltTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#383a3d';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 16000; i++) {
        const x = Math.random() * 512, y = Math.random() * 512;
        const len = 2 + Math.random() * 5, ang = Math.random() * Math.PI * 2;
        ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(6, 4);
      return tex;
    }

    function createWindshieldTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 256;
      const ctx = c.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, '#138eb5'); grad.addColorStop(1, '#26b0d6');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 512, 256);

      // Brilho plástico translúcido superior
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(16, 12, 480, 22);

      // Óculos escuros azuis (formato fiel à foto frontal do carrinho do Ravi)
      ctx.fillStyle = '#073c78';
      ctx.strokeStyle = '#052c59';
      ctx.lineWidth = 8;

      // Lente esquerda
      ctx.beginPath();
      ctx.roundRect(72, 68, 158, 106, [18, 18, 48, 42]);
      ctx.fill(); ctx.stroke();

      // Lente direita
      ctx.beginPath();
      ctx.roundRect(282, 68, 158, 106, [18, 18, 42, 48]);
      ctx.fill(); ctx.stroke();

      // Ponte central dos óculos
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(226, 98);
      ctx.quadraticCurveTo(256, 86, 286, 98);
      ctx.stroke();

      // Reflexos brancos duplos inclinados em cada lente
      ctx.strokeStyle = '#ffffff';
      ctx.lineCap = 'round';
      // Lente esquerda
      ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(106, 92); ctx.lineTo(148, 146); ctx.stroke();
      ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(148, 88); ctx.lineTo(180, 130); ctx.stroke();
      // Lente direita
      ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(318, 92); ctx.lineTo(360, 146); ctx.stroke();
      ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(360, 88); ctx.lineTo(392, 130); ctx.stroke();

      // Sorrisinho azul escuro centralizado abaixo da ponte
      ctx.strokeStyle = '#052c59';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(256, 186, 18, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      return new THREE.CanvasTexture(c);
    }

    // Decal transparente apenas com o logotipo branco "// Fire Engine //" (para aplicar sobre o plástico 3D laranja real)
    function createFireEngineLogoTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 512, 128);

      ctx.fillStyle = '#ffffff';
      // Duas barras paralelas inclinadas à esquerda "//"
      function drawSlashes(startX) {
        for (let i = 0; i < 2; i++) {
          const x = startX + i * 32;
          ctx.beginPath();
          ctx.moveTo(x + 18, 34);
          ctx.lineTo(x + 38, 34);
          ctx.lineTo(x + 20, 92);
          ctx.lineTo(x, 92);
          ctx.closePath();
          ctx.fill();
        }
      }
      drawSlashes(22);
      ctx.font = '900 54px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('Fire Engine', 102, 63);
      drawSlashes(412);

      return new THREE.CanvasTexture(c);
    }

    // Monitor Ultrawide Dinâmico (Atualiza quando o carrinho digita no teclado ou quando pega fogo/explode!)
    const monitorCanvas = document.createElement('canvas');
    monitorCanvas.width = 1024;
    monitorCanvas.height = 420;
    const monitorCtx = monitorCanvas.getContext('2d');
    const monitorTexture = new THREE.CanvasTexture(monitorCanvas);
    monitorTexture.encoding = THREE.sRGBEncoding; // cores fiéis ao canvas (sem desbotar)

    // Tela do notebook espelha o monitor (recorte central com a proporção da tela do notebook)
    const laptopScreenCanvas = document.createElement('canvas');
    laptopScreenCanvas.width = 512; laptopScreenCanvas.height = 316;
    const laptopScreenCtx = laptopScreenCanvas.getContext('2d');
    const laptopScreenTexture = new THREE.CanvasTexture(laptopScreenCanvas);
    laptopScreenTexture.encoding = THREE.sRGBEncoding;
    function mirrorMonitorToLaptop() {
      laptopScreenCtx.drawImage(monitorCanvas, 172, 0, 680, 420, 0, 0, 512, 316);
      laptopScreenTexture.needsUpdate = true;
    }

    let typedTextLines = ['> terminal ready...'];
    let selfDestructProgress = 0; // 0 a 100
    let monitorState = 'normal'; // 'normal', 'burning', 'exploded'
    let fireTimer = 15.0;
    let monitorProfileMode = null; // null | 'linkedin' | 'trailhead' (escolhido no notebook)

    // Versões mini dos perfis profissionais desenhadas na tela ultrawide (1024 x 420)
    function drawProfileAvatar(ctx, cx, cy, r, ringText) {
      const ring = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      ring.addColorStop(0, '#f2f4f7'); ring.addColorStop(0.5, '#9aa3ad'); ring.addColorStop(1, '#e6e9ee');
      ctx.fillStyle = ring;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2b2e35';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.68, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(r * 0.55)}px Nunito, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('JG', cx, cy + 2);
      ctx.font = `800 ${Math.round(r * 0.17)}px Nunito, sans-serif`;
      ctx.fillStyle = '#2b2e35';
      const chars = ringText.split('');
      chars.forEach((ch, i) => {
        const a = -Math.PI * 0.92 + (i / (chars.length - 1)) * Math.PI * 0.84;
        ctx.save();
        ctx.translate(cx + Math.cos(a) * r * 0.84, cy + Math.sin(a) * r * 0.84);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      });
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    function drawProfileScreen(ctx, mode) {
      const W = 1024, H = 420;
      if (mode === 'linkedin') {
        ctx.fillStyle = '#1b1f23'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1d2226'; ctx.fillRect(0, 0, W, 46);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(24, 9, 28, 28);
        ctx.fillStyle = '#0a66c2'; ctx.font = '900 22px Nunito, sans-serif'; ctx.fillText('in', 28, 31);
        ctx.fillStyle = '#9aa3ad'; ctx.font = '600 15px Nunito, sans-serif';
        ctx.fillText('linkedin.com/in/jefersonribeirogomes', 70, 29);
        ctx.fillStyle = '#f3f2f8'; ctx.fillRect(170, 60, 690, 110);
        [[190, 70, 40], [560, 68, 70], [700, 110, 34], [810, 64, 46], [300, 140, 26]].forEach(([x, y, s], i) => {
          ctx.fillStyle = i % 2 ? '#a5b4fc' : '#5b4ff0'; ctx.fillRect(x, y, s, s);
        });
        ctx.fillStyle = '#3d3d4e'; ctx.font = '600 16px Nunito, sans-serif';
        ctx.fillText('Arquiteto de Soluções de IA &', 640, 115);
        ctx.fillText('Especialista em Integração (MuleSoft/Salesforce)', 560, 138);
        ctx.fillStyle = '#1b1f23'; ctx.fillRect(170, 170, 690, 240);
        drawProfileAvatar(ctx, 270, 180, 78, 'AGENTBLAZER CHAMPION');
        ctx.fillStyle = '#ffffff'; ctx.font = '800 34px Nunito, sans-serif';
        ctx.fillText('Jeferson (Jheff) Gomes', 200, 300);
        ctx.fillStyle = '#d0d4d9'; ctx.font = '600 19px Nunito, sans-serif';
        ctx.fillText('Arquiteto de Soluções de IA | Desenvolvedor Senior MuleSoft | Agentblazer', 200, 334);
        ctx.fillStyle = '#9aa3ad'; ctx.font = '600 17px Nunito, sans-serif';
        ctx.fillText('São Paulo, Brasil  ·  UNINOVE', 200, 364);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(640, 250, 44, 44);
        ctx.fillStyle = '#c21515'; ctx.font = '900 11px Nunito, sans-serif'; ctx.fillText('UNINOVE', 642, 276);
        ctx.fillStyle = '#ffffff'; ctx.font = '700 20px Nunito, sans-serif'; ctx.fillText('UNINOVE', 696, 280);
        ctx.strokeStyle = '#70b5f9'; ctx.lineWidth = 2;
        ctx.strokeRect(640, 318, 190, 34);
        ctx.fillStyle = '#70b5f9'; ctx.font = '700 16px Nunito, sans-serif'; ctx.fillText('Abrir no notebook ↗', 655, 341);
      } else {
        ctx.fillStyle = '#f4f6f9'; ctx.fillRect(0, 0, W, H);
        const sky = ctx.createLinearGradient(0, 0, 0, 130);
        sky.addColorStop(0, '#ffe8a3'); sky.addColorStop(1, '#ffd27a');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, W, 130);
        ctx.fillStyle = '#3e8e41';
        for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.moveTo(i * 120 - 20, 130); ctx.lineTo(i * 120 + 30, 50 + (i % 3) * 18); ctx.lineTo(i * 120 + 80, 130); ctx.fill(); }
        ctx.fillStyle = '#00a1e0';
        [[60, 34, 22], [84, 26, 26], [110, 34, 22], [84, 42, 20]].forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
        ctx.fillStyle = '#ffffff'; ctx.font = '700 14px Nunito, sans-serif'; ctx.fillText('salesforce', 52, 39);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 110, 470, 296); ctx.fillRect(530, 110, 454, 296);
        drawProfileAvatar(ctx, 140, 190, 70, 'AGENTBLAZER CHAMPION');
        ctx.fillStyle = '#181818'; ctx.font = '800 30px Nunito, sans-serif'; ctx.fillText('Jeferson Gomes', 60, 300);
        ctx.fillStyle = '#3e3e3c'; ctx.font = '600 16px Nunito, sans-serif';
        ctx.fillText('Arquiteto de Soluções de IA | Desenvolvedor', 60, 330);
        ctx.fillText('Senior MuleSoft · São Paulo, Brasil', 60, 352);
        ctx.fillText('12+ anos projetando ecossistemas de APIs', 60, 382);
        ctx.fillStyle = '#181818'; ctx.font = '700 22px Nunito, sans-serif'; ctx.fillText('Trailhead', 556, 145);
        // Emblema de patente Mountaineer
        ctx.fillStyle = '#1b5d8c'; ctx.beginPath(); ctx.moveTo(700, 165); ctx.lineTo(760, 160); ctx.lineTo(820, 165); ctx.lineTo(820, 250); ctx.lineTo(700, 250); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#9fd7ff'; ctx.fillRect(708, 172, 104, 50);
        ctx.fillStyle = '#ffffff'; ctx.font = '900 13px Nunito, sans-serif'; ctx.fillText('MOUNTAINEER', 713, 242);
        [['58', 'Emblemas', 580], ['20.425', 'Pontos', 700], ['8', 'Trilhas', 860]].forEach(([n, l, x]) => {
          ctx.fillStyle = '#2e844a'; ctx.font = '800 30px Nunito, sans-serif'; ctx.fillText(n, x, 300);
          ctx.fillStyle = '#3e3e3c'; ctx.font = '600 15px Nunito, sans-serif'; ctx.fillText(l, x, 322);
        });
        const banner = ctx.createLinearGradient(556, 340, 960, 390);
        banner.addColorStop(0, '#e3ecff'); banner.addColorStop(1, '#cfe4ff');
        ctx.fillStyle = banner; ctx.fillRect(556, 340, 404, 52);
        ctx.fillStyle = '#0b5cab'; ctx.font = 'italic 900 24px Nunito, sans-serif'; ctx.fillText("Agentblazer Champion '26", 574, 375);
      }
    }

    function updateMonitorScreen() {
      const ctx = monitorCtx;
      if (monitorProfileMode && monitorState === 'normal') {
        drawProfileScreen(ctx, monitorProfileMode);
        monitorTexture.needsUpdate = true;
        mirrorMonitorToLaptop();
        return;
      }
      if (monitorState === 'exploded') {
        // Tela quebrada / estilhaçada preta
        ctx.fillStyle = '#0a0b0d';
        ctx.fillRect(0, 0, 1024, 420);
        ctx.strokeStyle = '#555d66';
        ctx.lineWidth = 3;
        for (let i = 0; i < 28; i++) {
          ctx.beginPath();
          ctx.moveTo(512, 210);
          ctx.lineTo(Math.random() * 1024, Math.random() * 420);
          ctx.stroke();
        }
        ctx.fillStyle = '#ff3333';
        ctx.font = 'bold 34px monospace';
        ctx.fillText('SYSTEM DESTROYED // NO SIGNAL', 210, 220);
        monitorTexture.needsUpdate = true;
        mirrorMonitorToLaptop();
        return;
      }

      if (monitorState === 'burning') {
        ctx.fillStyle = '#4a0808';
        ctx.fillRect(0, 0, 1024, 420);
        ctx.fillStyle = '#ffeb3b';
        ctx.font = 'bold 36px monospace';
        ctx.fillText('⚠️ SELF-DESTRUCT SEQUENCE ACTIVE! ⚠️', 120, 120);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px monospace';
        ctx.fillText('OVERHEATING! EXTINGUISH WITH WATER NOW!', 155, 200);
        ctx.fillStyle = '#ff5722';
        ctx.fillRect(150, 260, 724 * (fireTimer / 15.0), 40);
        monitorTexture.needsUpdate = true;
        mirrorMonitorToLaptop();
        return;
      }

      // Estado normal: tela do Antigravity carregando ("passe o carrinho pelo teclado")
      // e, quando o carrinho digita, o terminal com as linhas digitadas. Conteúdo centralizado
      // (x 172..852) para que o notebook mostre exatamente a mesma tela recortada.
      const t = performance.now() / 1000;
      const bg = ctx.createLinearGradient(0, 0, 0, 420);
      bg.addColorStop(0, '#0e1118'); bg.addColorStop(1, '#151a26');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1024, 420);
      const glow = ctx.createRadialGradient(512, 150, 10, 512, 150, 340);
      glow.addColorStop(0, 'rgba(120, 110, 255, 0.28)'); glow.addColorStop(1, 'rgba(120, 110, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 1024, 420);
      ctx.textAlign = 'center';
      const typing = typedTextLines.length > 1 || selfDestructProgress > 0;
      if (!typing) {
        // Logo: anel com órbita + nome
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(512, 140, 46, 0, Math.PI * 2); ctx.stroke();
        for (let i = 0; i < 3; i++) {
          const a = t * 2.4 + i * (Math.PI * 2 / 3);
          ctx.fillStyle = ['#8b7bff', '#4cc9f0', '#ffceca'][i];
          ctx.beginPath(); ctx.arc(512 + Math.cos(a) * 46, 140 + Math.sin(a) * 46, 8, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.moveTo(512, 112); ctx.lineTo(536, 160); ctx.lineTo(488, 160); ctx.closePath(); ctx.fill();
        ctx.font = '800 44px Nunito, sans-serif';
        ctx.fillText('Antigravity', 512, 245);
        ctx.fillStyle = '#9aa4b8'; ctx.font = '600 22px Nunito, sans-serif';
        const dots = '.'.repeat(1 + Math.floor(t * 2) % 3);
        ctx.fillText(`Carregando${dots}  passe o carrinho pelo teclado ⌨️`, 512, 290);
        // Barra indeterminada
        ctx.fillStyle = '#232a3a'; ctx.fillRect(312, 320, 400, 10);
        const sx = 312 + ((t * 180) % 520) - 120;
        const bar = ctx.createLinearGradient(sx, 0, sx + 120, 0);
        bar.addColorStop(0, 'rgba(139,123,255,0)'); bar.addColorStop(0.5, '#8b7bff'); bar.addColorStop(1, 'rgba(76,201,240,0)');
        ctx.fillStyle = bar;
        ctx.fillRect(Math.max(312, sx), 320, Math.min(120, 712 - Math.max(312, sx)), 10);
      } else {
        ctx.fillStyle = '#ffffff'; ctx.font = '800 26px Nunito, sans-serif';
        ctx.fillText('Antigravity · terminal', 512, 52);
        ctx.fillStyle = '#232a3a'; ctx.fillRect(262, 70, 500, 14);
        ctx.fillStyle = selfDestructProgress > 70 ? '#ff3d00' : '#ffab00';
        ctx.fillRect(262, 70, 5 * selfDestructProgress, 14);
        ctx.fillStyle = '#e2e8f0'; ctx.font = '700 13px monospace';
        ctx.fillText(`AUTO-DESTRUCT CODE: ${Math.floor(selfDestructProgress)}%`, 512, 104);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#7ee787'; ctx.font = '17px monospace';
        typedTextLines.slice(-11).forEach((line, idx) => ctx.fillText(line.slice(0, 52), 196, 140 + idx * 25));
        if (Math.floor(t * 2) % 2) ctx.fillRect(196, 140 + Math.min(10, typedTextLines.length) * 25 - 14, 10, 18);
      }
      ctx.textAlign = 'left';
      monitorTexture.needsUpdate = true;
      mirrorMonitorToLaptop();
    }
    updateMonitorScreen();

    // Texturas de Alta Fidelidade com Base nas Fotos Reais do Setup
    // ----------------------------------------------------------------------------
    function createMulesoftMentorTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 512, 512);

      const cx = 256, cy = 256, rOuter = 232;

      // Círculo base azul escuro / navy profundo (#071520)
      ctx.fillStyle = '#071520';
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      ctx.fill();

      // Borda externa azul ciano MuleSoft (#00a1e0)
      ctx.strokeStyle = '#00a1e0';
      ctx.lineWidth = 14;
      ctx.stroke();

      // Anel interno fino concêntrico
      ctx.beginPath();
      ctx.arc(cx, cy, 192, 0, Math.PI * 2);
      ctx.strokeStyle = '#0087be';
      ctx.lineWidth = 3.5;
      ctx.stroke();

      // Texto circular superior: "M U L E S O F T"
      ctx.save();
      ctx.translate(cx, cy);
      const textTop = "M U L E S O F T";
      ctx.font = '900 34px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const angleSpreadTop = Math.PI * 0.76;
      const startAngleTop = -Math.PI / 2 - angleSpreadTop / 2;
      const stepTop = angleSpreadTop / (textTop.length - 1);
      for (let i = 0; i < textTop.length; i++) {
        const angle = startAngleTop + i * stepTop;
        ctx.save();
        ctx.rotate(angle + Math.PI / 2);
        ctx.translate(0, -156);
        ctx.fillText(textTop[i], 0, 0);
        ctx.restore();
      }

      // Texto circular inferior: "M E N T O R"
      const textBottom = "M E N T O R";
      ctx.font = '900 36px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = '#ffffff';
      const angleSpreadBottom = Math.PI * 0.54;
      const startAngleBottom = Math.PI / 2 + angleSpreadBottom / 2;
      const stepBottom = angleSpreadBottom / (textBottom.length - 1);
      for (let i = 0; i < textBottom.length; i++) {
        const angle = startAngleBottom - i * stepBottom;
        ctx.save();
        ctx.rotate(angle - Math.PI / 2);
        ctx.translate(0, 156);
        ctx.fillText(textBottom[i], 0, 0);
        ctx.restore();
      }
      ctx.restore();

      // Círculo central azul claro céu com gradiente suave
      const rCenter = 126;
      const centerGrad = ctx.createRadialGradient(cx, cy - 20, 10, cx, cy, rCenter);
      centerGrad.addColorStop(0, '#ebf6fd');
      centerGrad.addColorStop(0.65, '#c5e7f9');
      centerGrad.addColorStop(1, '#9ad3f3');
      ctx.fillStyle = centerGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, rCenter, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#00a1e0';
      ctx.lineWidth = 4;
      ctx.stroke();

      // Estrelinhas cintilantes de 4 pontas ao redor do cubo
      function drawSparkle(sx, sy, sz) {
        ctx.fillStyle = '#00a1e0';
        ctx.beginPath();
        ctx.moveTo(sx, sy - sz);
        ctx.quadraticCurveTo(sx, sy, sx + sz, sy);
        ctx.quadraticCurveTo(sx, sy, sx, sy + sz);
        ctx.quadraticCurveTo(sx, sy, sx - sz, sy);
        ctx.quadraticCurveTo(sx, sy, sx, sy - sz);
        ctx.fill();
      }
      drawSparkle(cx - 72, cy - 54, 8);
      drawSparkle(cx + 74, cy - 48, 7);
      drawSparkle(cx - 68, cy + 32, 6);
      drawSparkle(cx + 70, cy + 36, 6);

      // Cubo Isométrico 3D MuleSoft no centro
      const bx = cx, by = cy - 8, bw = 46, bh = 26;
      // Face superior do cubo
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#00a1e0';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(bx, by - bh);
      ctx.lineTo(bx + bw, by);
      ctx.lineTo(bx, by + bh);
      ctx.lineTo(bx - bw, by);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Emblema "M" da MuleSoft na face superior do cubo
      ctx.fillStyle = '#00a1e0';
      ctx.beginPath();
      ctx.arc(bx, by, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('M', bx, by + 1);

      // Face esquerda do cubo
      ctx.fillStyle = '#d7effb';
      ctx.beginPath();
      ctx.moveTo(bx - bw, by);
      ctx.lineTo(bx, by + bh);
      ctx.lineTo(bx, by + bh + 48);
      ctx.lineTo(bx - bw, by + 48);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Face direita do cubo
      ctx.fillStyle = '#bfe4f8';
      ctx.beginPath();
      ctx.moveTo(bx, by + bh);
      ctx.lineTo(bx + bw, by);
      ctx.lineTo(bx + bw, by + 48);
      ctx.lineTo(bx, by + bh + 48);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      // Duas mãos estilizadas segurando o cubo de baixo
      ctx.strokeStyle = '#00a1e0';
      ctx.fillStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Mão esquerda
      ctx.beginPath();
      ctx.moveTo(bx - 48, by + 74);
      ctx.lineTo(bx - 48, by + 26);
      ctx.lineTo(bx - 36, by + 18);
      ctx.lineTo(bx - 36, by + 74);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - 26, by + 26);
      ctx.lineTo(bx - 26, by + 74);
      ctx.stroke();

      // Mão direita
      ctx.beginPath();
      ctx.moveTo(bx + 48, by + 74);
      ctx.lineTo(bx + 48, by + 26);
      ctx.lineTo(bx + 36, by + 18);
      ctx.lineTo(bx + 36, by + 74);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx + 26, by + 26);
      ctx.lineTo(bx + 26, by + 74);
      ctx.stroke();

      return new THREE.CanvasTexture(c);
    }

    function createLeatherCoasterTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#78432a';
      ctx.fillRect(0, 0, 256, 256);
      // Grão de couro suave
      for (let i = 0; i < 700; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
      // Costura perimetral pontilhada clara
      ctx.strokeStyle = '#ebd9c6';
      ctx.lineWidth = 3.0;
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.arc(128, 128, 114, 0, Math.PI * 2);
      ctx.stroke();
      return new THREE.CanvasTexture(c);
    }

    function createCorkTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#b7885b';
      ctx.fillRect(0, 0, 256, 128);
      const corkColors = ['#9b6b40', '#cf9e6f', '#784d28', '#dcb284', '#663f1e'];
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = corkColors[Math.floor(Math.random() * corkColors.length)];
        const w = 2 + Math.random() * 5;
        const h = 2 + Math.random() * 3;
        ctx.fillRect(Math.random() * 256, Math.random() * 128, w, h);
      }
      return new THREE.CanvasTexture(c);
    }

    function createCopilotStickerTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 180;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 256, 180);

      // Borda externa branca do sticker
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.roundRect(14, 14, 228, 152, 40);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Fita em laço com gradiente icônico do Microsoft Copilot
      const grad1 = ctx.createLinearGradient(35, 35, 140, 145);
      grad1.addColorStop(0, '#0078d4');
      grad1.addColorStop(0.5, '#00d2ff');
      grad1.addColorStop(1, '#107c41');

      const grad2 = ctx.createLinearGradient(120, 35, 220, 145);
      grad2.addColorStop(0, '#ffb900');
      grad2.addColorStop(0.45, '#e81123');
      grad2.addColorStop(0.8, '#b4009e');
      grad2.addColorStop(1, '#5c2d91');

      ctx.fillStyle = grad1;
      ctx.beginPath();
      ctx.roundRect(32, 32, 94, 116, 28);
      ctx.fill();

      ctx.fillStyle = grad2;
      ctx.beginPath();
      ctx.roundRect(102, 32, 120, 116, 32);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(75, 54, 102, 72, 22);
      ctx.fill();

      const gradCore = ctx.createLinearGradient(85, 60, 170, 120);
      gradCore.addColorStop(0, '#26d0ce');
      gradCore.addColorStop(0.5, '#a770ef');
      gradCore.addColorStop(1, '#ff6a00');
      ctx.fillStyle = gradCore;
      ctx.beginPath();
      ctx.roundRect(84, 62, 84, 56, 16);
      ctx.fill();

      return new THREE.CanvasTexture(c);
    }

    function createElgTagTexture() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#b37850';
      ctx.fillRect(0, 0, 128, 64);
      ctx.strokeStyle = '#e6c8a8';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(5, 5, 118, 54);
      ctx.fillStyle = '#5c3116';
      ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('elg', 64, 33);
      return new THREE.CanvasTexture(c);
    }

    function createWarningStickerTexture() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = '#f7d117';
      ctx.beginPath();
      ctx.moveTo(64, 12);
      ctx.lineTo(122, 114);
      ctx.lineTo(6, 114);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.fillStyle = '#111111';
      ctx.font = '900 68px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 64, 78);
      return new THREE.CanvasTexture(c);
    }

    // Textura do Chassi Preto Grafite do Logitech G213 Prodigy
    function createG213DeckTexture() {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 480;
      const ctx = c.getContext('2d');

      // Fundo preto grafite fosco (#1b1e22)
      ctx.fillStyle = '#1b1e22';
      ctx.fillRect(0, 0, 1024, 480);

      // Logo "G" Ciano Iluminado no canto superior esquerdo (acima do Esc)
      ctx.fillStyle = '#00a8ff';
      ctx.shadowColor = '#00a8ff';
      ctx.shadowBlur = 14;
      ctx.font = '900 44px "Segoe UI", Arial, sans-serif';
      ctx.fillText('G', 42, 54);
      ctx.shadowBlur = 0;

      // Inscrição sutil do modelo "G213" no perfil da borda direita
      ctx.fillStyle = '#3a404a';
      ctx.font = 'bold 24px "Segoe UI", sans-serif';
      ctx.fillText('G213', 940, 455);

      // LEDs de status no centro do topo (Caps Lock, Num Lock, Scroll Lock)
      const leds = ['CAPS', 'NUM', 'SCROLL'];
      leds.forEach((name, i) => {
        const lx = 470 + i * 42;
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath(); ctx.arc(lx, 26, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#677180';
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText(name, lx - 10, 42);
      });

      return new THREE.CanvasTexture(c);
    }

    // Textura de alumínio escovado para compatibilidade
    function createG915DeckTexture() {
      return createG213DeckTexture();
    }

    function createLaptopScreenTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 320;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#191b1f'; ctx.fillRect(0, 0, 512, 320);
      ctx.fillStyle = '#21242b'; ctx.fillRect(0, 24, 110, 276);
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = '#f0c674'; ctx.fillRect(130, 50 + i * 18, 14, 10);
        ctx.fillStyle = '#abb2bf'; ctx.fillRect(152, 52 + i * 18, 120 + (i % 3) * 40, 6);
      }
      ctx.fillStyle = '#111317'; ctx.fillRect(0, 300, 512, 20);
      return new THREE.CanvasTexture(c);
    }

    function createHexStickerTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const ctx = c.getContext('2d');
      const grad = ctx.createLinearGradient(20, 20, 236, 108);
      grad.addColorStop(0, '#26d0ce'); grad.addColorStop(0.35, '#a770ef');
      grad.addColorStop(0.7, '#cf8bf3'); grad.addColorStop(1, '#fdb99b');
      ctx.fillStyle = grad; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.roundRect(24, 18, 208, 92, 36); ctx.fill(); ctx.stroke();
      return new THREE.CanvasTexture(c);
    }

    function createHeartStickerTexture() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      function heartPath(cx, cy, size) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + size * 0.35);
        ctx.bezierCurveTo(cx, cy, cx - size * 0.5, cy, cx - size * 0.5, cy + size * 0.35);
        ctx.bezierCurveTo(cx - size * 0.5, cy + size * 0.7, cx, cy + size * 0.9, cx, cy + size * 1.15);
        ctx.bezierCurveTo(cx, cy + size * 0.9, cx + size * 0.5, cy + size * 0.7, cx + size * 0.5, cy + size * 0.35);
        ctx.bezierCurveTo(cx + size * 0.5, cy, cx, cy, cx, cy + size * 0.35);
        ctx.closePath();
      }
      heartPath(64, 14, 92); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.save(); heartPath(64, 20, 80); ctx.clip();
      const cols = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#ff7f50'];
      for (let r = 0; r < 4; r++) {
        for (let col = 0; col < 4; col++) {
          ctx.fillStyle = cols[(r * 4 + col) % cols.length];
          ctx.fillRect(16 + col * 24, 16 + r * 26, 25, 27);
        }
      }
      ctx.restore();
      heartPath(64, 14, 92); ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      return new THREE.CanvasTexture(c);
    }

    // Piso no estilo do mundo do DS (Bruno Simon): lajotas laranja-pêssego com juntas,
    // leves variações de tom e folhinhas vermelhas caídas.
    function createTileFloorTexture() {
      const S = 1024, N = 8, T = S / N;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      let seed = 11;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      ctx.fillStyle = '#d9853f';
      ctx.fillRect(0, 0, S, S);
      const tones = ['#f2a45e', '#efa058', '#f4ab66', '#ec9a50', '#f6b06c'];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const px = x * T + 3, py = y * T + 3, w = T - 6;
          ctx.fillStyle = tones[Math.floor(rnd() * tones.length)];
          ctx.fillRect(px, py, w, w);
          // Bisel: luz no topo/esquerda e sombra embaixo/direita
          ctx.fillStyle = 'rgba(255, 230, 190, 0.35)';
          ctx.fillRect(px, py, w, 4); ctx.fillRect(px, py, 4, w);
          ctx.fillStyle = 'rgba(150, 70, 20, 0.22)';
          ctx.fillRect(px, py + w - 4, w, 4); ctx.fillRect(px + w - 4, py, 4, w);
          // Manchinhas de textura de pedra
          for (let k = 0; k < 6; k++) {
            ctx.fillStyle = `rgba(190, 100, 40, ${0.06 + rnd() * 0.08})`;
            ctx.beginPath();
            ctx.arc(px + rnd() * w, py + rnd() * w, 3 + rnd() * 9, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // Folhinhas vermelhas e alaranjadas caídas (como no mundo do DS)
      for (let i = 0; i < 70; i++) {
        ctx.save();
        ctx.translate(rnd() * S, rnd() * S);
        ctx.rotate(rnd() * Math.PI);
        ctx.fillStyle = ['#c0392b', '#d35400', '#a8322a', '#e67e22'][Math.floor(rnd() * 4)];
        ctx.fillRect(-5, -3, 10, 6);
        ctx.restore();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(7.5, 5.4);
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 8;
      return tex;
    }

    function createStripedRugTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#18191c';
      ctx.fillRect(0, 0, 512, 512);
      for (let y = 0; y < 512; y += 14) {
        const isWhite = (Math.sin(y * 0.16) > -0.25);
        ctx.fillStyle = isWhite ? '#ededeb' : '#22252a';
        ctx.fillRect(0, y, 512, isWhite ? 7 : 7);
        for (let x = 0; x < 512; x += 8) {
          if (Math.random() > 0.45) {
            ctx.fillStyle = isWhite ? '#2e3238' : '#d2d2d0';
            ctx.fillRect(x, y + Math.random() * 4, 3, 2);
          }
        }
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 2);
      return tex;
    }

    function createClayPebblesTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3a1e12';
      ctx.fillRect(0, 0, 256, 256);
      const cols = ['#9e472a', '#b85c37', '#80381e', '#6e3019', '#ca6c44'];
      for (let i = 0; i < 110; i++) {
        const px = (i * 41) % 256;
        const py = (i * 67) % 256;
        const r = 9 + (i % 7);
        const grad = ctx.createRadialGradient(px - r * 0.35, py - r * 0.35, r * 0.1, px, py, r);
        grad.addColorStop(0, cols[i % cols.length]);
        grad.addColorStop(1, '#231109');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      return new THREE.CanvasTexture(c);
    }

    function createPegboardTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#16171a';
      ctx.fillRect(0, 0, 256, 512);
      ctx.fillStyle = '#08080a';
      for (let y = 16; y < 512; y += 22) {
        for (let x = 16; x < 256; x += 22) {
          ctx.beginPath();
          ctx.arc(x, y, 4.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return new THREE.CanvasTexture(c);
    }

    function createDeskControlTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#111215';
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = '#00e5ff';
      ctx.font = 'bold 22px monospace';
      ctx.fillText('73.5', 22, 40);
      ctx.font = 'bold 11px monospace';
      ctx.fillText('cm', 82, 40);
      ctx.fillStyle = '#8e96a3';
      ctx.font = 'bold 17px sans-serif';
      ctx.fillText('▲  ▼  1  2  3  M', 115, 39);
      return new THREE.CanvasTexture(c);
    }

    function createElementsChairTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#18191c';
      ctx.fillRect(0, 0, 256, 128);
      ctx.fillStyle = '#22252a';
      ctx.beginPath();
      ctx.roundRect(24, 34, 208, 60, 10);
      ctx.fill();
      ctx.fillStyle = '#e01616';
      ctx.fillRect(38, 48, 8, 32);
      ctx.fillStyle = '#f0f3f6';
      ctx.font = '900 24px "Nunito", sans-serif';
      ctx.letterSpacing = '3px';
      ctx.fillText('ELEMENTS', 56, 72);
      return new THREE.CanvasTexture(c);
    }

    function createReturnCardboardTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#b58555';
      ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = 'rgba(90, 55, 25, 0.18)';
      ctx.lineWidth = 3;
      for (let y = 0; y < 512; y += 8) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(215, 195, 160, 0.8)';
      ctx.fillRect(0, 40, 512, 45);
      ctx.fillStyle = '#2b1b0e';
      ctx.font = 'bold 28px "Nunito", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⬆ SUBIDA PARA A MESA ⬆', 256, 230);
      ctx.font = 'bold 22px monospace';
      ctx.fillStyle = '#1b5e20';
      ctx.fillText('(RETORNO AO DESK)', 256, 275);
      return new THREE.CanvasTexture(c);
    }

    function createCardboardTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ba8c5c';
      ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = 'rgba(90, 55, 25, 0.18)';
      ctx.lineWidth = 3;
      for (let y = 0; y < 512; y += 8) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
      }
      // Fita adesiva e aviso escrito à mão no papelão
      ctx.fillStyle = 'rgba(215, 195, 160, 0.75)';
      ctx.fillRect(0, 35, 512, 42);
      ctx.fillStyle = '#2b1b0e';
      ctx.font = 'bold 30px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⬇ RAMPA: CENÁRIO QUARTO ⬇', 256, 230);
      ctx.font = 'bold 22px monospace';
      ctx.fillStyle = '#8c1d18';
      ctx.fillStyle = '#00796b';
      ctx.fillText('✓ PISTA LIBERADA!', 256, 275);
      return new THREE.CanvasTexture(c);
    }

    function createShortcutCardboardTexture() {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#b88958';
      ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = 'rgba(90, 55, 25, 0.18)';
      ctx.lineWidth = 3;
      for (let y = 0; y < 512; y += 8) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
      }
      // Fita adesiva kraft com texto de atalho
      ctx.fillStyle = 'rgba(215, 195, 160, 0.85)';
      ctx.fillRect(0, 36, 512, 52);
      ctx.fillStyle = '#2b1b0e';
      ctx.font = 'bold 28px "Nunito", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡ ATALHO SOB A MESA · STUNT ⚡', 256, 230);
      ctx.font = 'bold 22px monospace';
      ctx.fillStyle = '#d84315';
      ctx.fillText('⬍ RAMPA BIDIRECIONAL ⬍', 256, 275);
      return new THREE.CanvasTexture(c);
    }

    function createCautionTapeTexture() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffbe0b';
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = '#1e2025';
      for (let x = -64; x < 320; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x + 22, 0); ctx.lineTo(x + 8, 64); ctx.lineTo(x - 14, 64);
        ctx.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(6, 1);
      return tex;
    }

    // ============================================================================
    // MESA DE TRABALHO EXPANDIDA 3X (180 x 108 UNIDADES!)
    // ============================================================================
    // ESTRUTURAS GLOBAIS DE OBSTÁCULOS, FÍSICA DINÂMICA, PLANTAS E ITENS ARRASTÁVEIS
    const obstacles = [];
    const dynamicObstacles = []; // Objetos que sofrem impulso físico, tombam e colidem entre si
    const occluderMeshes = [];   // Objetos grandes que ficam translúcidos (80-85%) quando obstruem a visão do carrinho
    const occludedMeshesSet = new Set();
    // Registra um objeto fixo grande como "oclusor": fica 90% transparente quando tapa o carrinho.
    // Cada malha ganha material próprio para que só o objeto da frente fique transparente.
    function registerOccluderTree(root) {
      if (!root) return;
      root.traverse((m) => {
        if (!m.isMesh || m.isSprite || m.userData.occluderRegistered) return;
        if (m.material && m.material.isShaderMaterial) return;
        m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
        m.userData.occluderRegistered = true;
        occluderMeshes.push(m);
      });
    }
    const occlusionRaycaster = new THREE.Raycaster();
    const growablePlants = [];
    const grabbableItems = [];
    let heldItem = null;
    function registerGrabbable(config) {
      grabbableItems.push(config);
      return config;
    }
    // Registrador de Obstáculo com Física Dinâmica
    // Altura (y) das superfícies onde os objetos repousam
    const DESK_SURFACE_Y = 0.0;
    const FLOOR_SURFACE_Y = -36.0;
    function surfaceBaseY(y) { return y > -15 ? DESK_SURFACE_Y : FLOOR_SURFACE_Y; }
    function levelOfY(y) { return y > -15 ? 'desk' : 'floor'; }

    function registerDynamicObstacle(config) {
      const obs = config.obs;
      obs.group = config.group;
      obs.isStatic = !!config.isStatic;
      obs.mass = config.mass || (obs.r * 0.85 + 0.6);
      obs.canTopple = config.canTopple !== undefined ? config.canTopple : true;
      obs.vx = 0; obs.vz = 0; obs.vy = 0; obs.vRotY = 0;
      obs.tiltX = 0; obs.tiltZ = 0;
      obs.initX = obs.x; obs.initZ = obs.z;
      obs.isFalling = false;
      if (obs.group) {
        // Offset de repouso relativo à superfície (mesa ou chão) — usado ao cair da mesa
        const gy = obs.group.position.y;
        obs.restOffset = gy - surfaceBaseY(gy);
        // No chão do quarto, a altura do gramado da ilha não faz parte do repouso (é somada pelo terreno a cada passo)
        if (levelOfY(gy) === 'floor' && typeof floorExtraHeight === 'function') {
          try { obs.restOffset -= Math.max(0, floorExtraHeight(obs.x, obs.z)); } catch (e) { /* ilhas ainda não criadas */ }
        }
        obs.initY = gy;
        obs.initRotY = obs.group.rotation.y;
        if (!obs.level) obs.level = levelOfY(gy);
      }
      obstacles.push(obs);
      if (!obs.isStatic) {
        obs._dyn = true;
        dynamicObstacles.push(obs);
      }
      return obs;
    }

    const deskWorld = new THREE.Group();
    scene.add(deskWorld);

    const DESK_HALF_W = 90; // 180 largura total
    const DESK_HALF_D = 54; // 108 profundidade total

    const deskMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c1f,
      roughness: 0.45,
      metalness: 0.1
    });
    const deskTop = new THREE.Mesh(new THREE.BoxGeometry(DESK_HALF_W * 2, 1.8, DESK_HALF_D * 2), deskMat);
    deskTop.position.set(0, -0.9, 0);
    deskTop.receiveShadow = true;
    deskTop.castShadow = true;
    deskWorld.add(deskTop);
    occluderMeshes.push(deskTop);

    // Pernas da mesa gerenciadas pelas colunas motorizadas da Standing Desk abaixo

    // Deskmat de Feltro Cinza-Chumbo Expandido
    const feltMat = new THREE.MeshStandardMaterial({
      map: createFeltTexture(),
      roughness: 0.92
    });
    const deskmat = new THREE.Mesh(new THREE.BoxGeometry(68, 0.14, 34), feltMat);
    deskmat.position.set(8, 0.07, 6);
    deskmat.receiveShadow = true;
    deskWorld.add(deskmat);

    // Etiqueta de couro sintético caramelo "elg" costurada na borda frontal do mousepad
    const elgTag = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.2),
      new THREE.MeshStandardMaterial({ map: createElgTagTexture(), roughness: 0.65 })
    );
    elgTag.rotation.x = -Math.PI / 2;
    elgTag.position.set(38.5, 0.16, 21.2);
    deskWorld.add(elgTag);

// Estruturas globais e registradores movidos para o topo


    // ============================================================================
    // SISTEMA DE RAMPAS CONTÍNUAS DE PAPELÃO (DESCIDA E SUBIDA MESA <-> QUARTO)
    // ============================================================================
    const rampGroup = new THREE.Group();
    const rampMat = new THREE.MeshStandardMaterial({ map: createCardboardTexture(), roughness: 0.85 });
    const returnRampMat = new THREE.MeshStandardMaterial({ map: createReturnCardboardTexture(), roughness: 0.85 });
    const shortcutRampMat = new THREE.MeshStandardMaterial({ map: createShortcutCardboardTexture(), roughness: 0.85 });
    const cautionTapeMat = new THREE.MeshStandardMaterial({ map: createCautionTapeTexture(), roughness: 0.5, metalness: 0.1 });

    // Dimensões exatas da rampa: de x = -90 (mesa, y = 0) até x = -135 (chão, y = -35.85)
    // Comprimento da diagonal: sqrt(45^2 + 35.85^2) ≈ 57.53 unidades! Ângulo: 0.673 rad.
    const RAMP_LEN = 57.53;
    const RAMP_ANGLE = Math.atan2(35.85, 45); // 0.673 rad (38.5°)

    // 1. RAMPA DE DESCIDA (Mesa -> Quarto) posicionada em z = 18
    const rampLip = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 16), rampMat);
    rampLip.position.set(-DESK_HALF_W + 5, 0.12, 18);
    rampLip.receiveShadow = true;
    rampGroup.add(rampLip);

    const rampMesh = new THREE.Mesh(new THREE.BoxGeometry(RAMP_LEN, 0.35, 16), rampMat);
    rampMesh.rotation.z = RAMP_ANGLE;
    rampMesh.position.set(-112.5, -17.925, 18);
    rampMesh.castShadow = true;
    rampMesh.receiveShadow = true;
    rampGroup.add(rampMesh);

    // Abas laterais de papelão da rampa de descida
    [-7.8, 7.8].forEach((rz) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(RAMP_LEN, 1.8, 0.35), rampMat);
      rail.rotation.z = RAMP_ANGLE;
      rail.position.set(-112.5, -17.2, 18 + rz);
      rampGroup.add(rail);
    });

    // 2. RAMPA DE SUBIDA / RETORNO (Quarto -> Mesa) posicionada paralelamente em z = 38
    const returnLip = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 16), returnRampMat);
    returnLip.position.set(-DESK_HALF_W + 5, 0.12, 38);
    returnLip.receiveShadow = true;
    rampGroup.add(returnLip);

    const returnMesh = new THREE.Mesh(new THREE.BoxGeometry(RAMP_LEN, 0.35, 16), returnRampMat);
    returnMesh.rotation.z = RAMP_ANGLE;
    returnMesh.position.set(-112.5, -17.925, 38);
    returnMesh.castShadow = true;
    returnMesh.receiveShadow = true;
    rampGroup.add(returnMesh);

    // Abas laterais de papelão da rampa de subida
    [-7.8, 7.8].forEach((rz) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(RAMP_LEN, 1.8, 0.35), returnRampMat);
      rail.rotation.z = RAMP_ANGLE;
      rail.position.set(-112.5, -17.2, 38 + rz);
      rampGroup.add(rail);
    });

    deskWorld.add(rampGroup); // << ADICIONA AS RAMPAS À CENA!


    // ============================================================================
    // CENÁRIO COMPLETO DO QUARTO & ESCRITÓRIO REAL (CHÃO y = -36.0)
    // ============================================================================
    const bedroomWorld = new THREE.Group();
    scene.add(bedroomWorld);

    // 1. CHÃO DE AZULEJO CERÂMICO CLARO DO QUARTO (y = -36.0)
    // Quarto expandido para acomodar o novo setor de Rally Off-Road e a Ilha do Baja!
    const floorGeo = new THREE.PlaneGeometry(410, 170); // recortado nas paredes (x -170..240, z -75..95)
    const floorMat = new THREE.MeshStandardMaterial({
      map: createTileFloorTexture(),
      roughness: 0.62,
      metalness: 0.0,
      envMap: envMapTexture,
      envMapIntensity: 0.25
    });
    const bedroomFloor = new THREE.Mesh(floorGeo, floorMat);
    bedroomFloor.rotation.x = -Math.PI / 2;
    bedroomFloor.position.set(35, -36.0, 10);
    floorMat.map.repeat.set(6 * 410 / 550, 4 * 170 / 260); // mesmo tamanho de azulejo de antes
    bedroomFloor.receiveShadow = true;
    bedroomWorld.add(bedroomFloor);

    // 1b. AS 4 PAREDES REAIS DO QUARTO (LIMITES FÍSICOS DA SALA)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ec, roughness: 0.85 });
    const baseboardMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.5 });

    const roomWallMeshes = [];
    function createRoomWall(w, h, d, px, py, pz) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      wall.position.set(px, py, pz);
      wall.receiveShadow = true;
      bedroomWorld.add(wall);
      // Rodapé escuro na base da parede
      const baseboard = new THREE.Mesh(new THREE.BoxGeometry(w > d ? w : 1.2, 2.5, d > w ? d : 1.2), baseboardMat);
      baseboard.position.set(px, py - h / 2 + 1.25, pz);
      bedroomWorld.add(baseboard);
      // Paredes ficam 90% transparentes quando estão entre a câmera e o carrinho
      registerOccluderTree(wall);
      registerOccluderTree(baseboard);
      roomWallMeshes.push(wall, baseboard);
      wall.material.userData.isWall = true;
      return wall;
    }

    // Parede Norte (Fundo): z = -75, cobrindo de x = -170 a x = 240
    createRoomWall(414, 56, 4, 35, -8, -75);
    // Parede Sul (Frente): z = 95, cobrindo de x = -170 a x = 240
    createRoomWall(414, 56, 4, 35, -8, 95);
    // Parede Oeste (Esquerda): x = -170
    createRoomWall(4, 56, 174, -170, -8, 10);
    // Parede Leste (Direita): x = 240 (quarto expandido para o setor de rally!)
    createRoomWall(4, 56, 174, 240, -8, 10);


    // 2. TAPETE LISTRADO PRETO E BRANCO (Estilo Tear Artesanal da Foto Real!)
    const rugMat = new THREE.MeshStandardMaterial({
      map: createStripedRugTexture(),
      roughness: 0.95
    });
    const stripedRug = new THREE.Mesh(new THREE.BoxGeometry(112, 0.16, 72), rugMat);
    stripedRug.position.set(-18, -35.92, 58);
    stripedRug.receiveShadow = true;
    bedroomWorld.add(stripedRug);
    stripedRug.visible = false; // o piso inteiro agora segue o estilo do mundo do DS (lajotas + gramados)

    // 3. ESTRUTURA METÁLICA MOTORIZADA DA MESA STANDING DESK (Colunas Telescópicas em T)
    const deskLegMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.32, metalness: 0.7 });
    // Sapatas horizontais de aço no chão
    [-68, 68].forEach((lx) => {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(6, 1.3, 42), deskLegMat);
      foot.position.set(lx, -35.35, 0);
      foot.castShadow = true;
      foot.receiveShadow = true;
      bedroomWorld.add(foot);

      // Colunas telescópicas duplas motorizadas
      // Coluna termina embaixo do tampo (y -1.8). Antes ia até y = 0 e o topo dela aparecia
      // como um quadrado preto "piscando" em cima da mesa (z-fighting com o tampo).
      const col = new THREE.Mesh(new THREE.BoxGeometry(4.8, 33.1, 4.8), deskLegMat);
      col.position.set(lx, -35.0 + 33.1 / 2, 0);
      col.castShadow = true;
      bedroomWorld.add(col);

      registerOccluderTree(col);
      // Registra obstáculos para as colunas no chão
      obstacles.push({ x: lx, z: 0, r: 4.8, name: 'COLUNA STANDING DESK MOTORIZADA', isStatic: true, level: 'floor' });
    });

    // Travessa de reforço horizontal sob a mesa
    const crossbeam = new THREE.Mesh(new THREE.BoxGeometry(136, 2.4, 3.2), deskLegMat);
    crossbeam.position.set(0, -2.1, 0);
    bedroomWorld.add(crossbeam);
    registerOccluderTree(crossbeam);

    // Controlador Digital com Display LED da Standing Desk
    const deskCtrlMesh = new THREE.Mesh(
      new THREE.BoxGeometry(6.4, 1.8, 0.25),
      new THREE.MeshStandardMaterial({ map: createDeskControlTexture(), roughness: 0.4 })
    );
    deskCtrlMesh.position.set(48, -1.2, 53.9);
    bedroomWorld.add(deskCtrlMesh);

    // 4. CADEIRA GAMER ELEMENTS (Base Estrela 5 Pontas, Rodinhas, Pistão, Assento e Logo!)
    const elementsChairGroup = new THREE.Group();
    elementsChairGroup.position.set(-18, -36.0, 82); // 28 cm à frente da borda da mesa (totalmente livre)

    const chairFabricMat = new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.85 });
    const chairBlackPlastMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.4, metalness: 0.2 });
    const chairChromeMat = new THREE.MeshStandardMaterial({ color: 0xdde3ea, metalness: 0.9, roughness: 0.15 });

    // Base Estrela de 5 Pontas com Rodinhas Duplas
    for (let i = 0; i < 5; i++) {
      const spokeAng = (i / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 7.2), chairBlackPlastMat);
      spoke.rotation.y = spokeAng;
      spoke.position.set(Math.sin(spokeAng) * 3.6, 0.8, Math.cos(spokeAng) * 3.6);
      spoke.castShadow = true;
      elementsChairGroup.add(spoke);

      // Rodinha dupla
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.85, 14), chairBlackPlastMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(Math.sin(spokeAng) * 7.2, 0.55, Math.cos(spokeAng) * 7.2);
      elementsChairGroup.add(wheel);
    }

    // Pistão a Gás Hidráulico
    const pistonOuter = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.45, 6.0, 18), chairBlackPlastMat);
    pistonOuter.position.y = 3.6;
    const pistonShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 6.2, 18), chairChromeMat);
    pistonShaft.position.y = 8.5;
    elementsChairGroup.add(pistonOuter, pistonShaft);

    // Assento Ergonômico com Abas Laterais Esportivas
    const seatBase = new THREE.Mesh(new THREE.BoxGeometry(13.5, 2.5, 13.5), chairFabricMat);
    seatBase.position.y = 11.2;
    seatBase.castShadow = true;
    elementsChairGroup.add(seatBase);

    [-6.2, 6.2].forEach((sx) => {
      const bolster = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.8, 13.0), chairFabricMat);
      bolster.rotation.z = sx > 0 ? -0.25 : 0.25;
      bolster.position.set(sx, 12.4, 0);
      elementsChairGroup.add(bolster);
    });

    // Encosto Alto Gamer com Aberturas de Cinto e Almofada Lombar
    const chairBack = new THREE.Mesh(new THREE.BoxGeometry(12.5, 22.0, 2.6), chairFabricMat);
    chairBack.position.set(0, 22.5, -5.8);
    chairBack.rotation.x = -0.06;
    chairBack.castShadow = true;
    elementsChairGroup.add(chairBack);

    // Almofada Lombar Ergonômica
    const lumbarCushion = new THREE.Mesh(
      new THREE.BoxGeometry(10.5, 5.2, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.8 })
    );
    lumbarCushion.position.set(0, 15.0, -4.6);
    elementsChairGroup.add(lumbarCushion);

    // Almofada de Cabeça com Logo Bordado "ELEMENTS"
    const headrestPillow = new THREE.Mesh(
      new THREE.BoxGeometry(7.5, 4.2, 2.4),
      new THREE.MeshStandardMaterial({ map: createElementsChairTexture(), roughness: 0.75 })
    );
    headrestPillow.position.set(0, 30.5, -4.8);
    headrestPillow.castShadow = true;
    elementsChairGroup.add(headrestPillow);

    // Braços 3D com Apoio Almofadado (o braço direito tem o descanso de punho cinza da foto!)
    [-7.8, 7.8].forEach((ax, idx) => {
      const armPost = new THREE.Mesh(new THREE.BoxGeometry(1.2, 7.2, 1.4), chairBlackPlastMat);
      armPost.position.set(ax, 15.2, 0.5);
      const armPad = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 7.8), chairBlackPlastMat);
      armPad.position.set(ax, 18.8, 0.5);
      elementsChairGroup.add(armPost, armPad);

      if (idx === 1) {
        // Almofada ergonômica de espuma cinza pousada sobre o braço (visível na foto do quarto!)
        const extraPad = new THREE.Mesh(
          new THREE.BoxGeometry(3.0, 1.2, 8.2),
          new THREE.MeshStandardMaterial({ color: 0x484d54, roughness: 0.9 })
        );
        extraPad.position.set(ax, 19.8, 0.5);
        elementsChairGroup.add(extraPad);
      }
    });

    bedroomWorld.add(elementsChairGroup);
    elementsChairGroup.traverse(m => { if (m.isMesh) occluderMeshes.push(m); });
    obstacles.push({ x: -18, z: 82, r: 7.2, name: 'CADEIRA GAMER ELEMENTS', isStatic: true, level: 'floor' });

    // 5. APOIO PARA PÉS DE ESCRITÓRIO SOB A MESA / STUNT RAMP BIDIRECIONAL COMPLETA
    const footrestGroup = new THREE.Group();
    footrestGroup.position.set(4, -36.0, -10);

    const footCardboardDark = rampMat.clone();
    footCardboardDark.color = new THREE.Color(0xa67c52);

    // Estrutura de base no chão sustentando toda a extensão (z de -24.0 a 4.5, total 28.5 unidades)
    const footBase = new THREE.Mesh(new THREE.BoxGeometry(17.2, 0.4, 28.5), footCardboardDark);
    footBase.position.set(0, 0.2, -0.25);
    footBase.receiveShadow = true;
    footrestGroup.add(footBase);

    // Pilares / costelas de papelão reforçado sob a rampa
    [
      [-6.5, -9.6, 0.7], [6.5, -9.6, 0.7],
      [-6.5, -3.5, 2.5], [6.5, -3.5, 2.5],
      [-6.5, 2.5, 4.4], [6.5, 2.5, 4.4],
      [-6.5, 8.5, 2.0], [6.5, 8.5, 2.0]
    ].forEach(([px, pz, ph]) => {
      const col = new THREE.Mesh(new THREE.BoxGeometry(1.6, ph, 1.8), footCardboardDark);
      col.position.set(px, ph / 2 + 0.2, pz);
      col.castShadow = true;
      footrestGroup.add(col);
    });

    const RAMP_W = 16.2;
    const RAIL_H = 1.8;
    const RAIL_THICK = 0.35;

    // SEÇÃO 1: Rampa Traseira de Entrada (sobe suavemente de z: -24.0 a -15.2, altura 0 a 1.17)
    const lenA = 8.88, angA = 0.1318;
    const rampA = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W, 0.45, lenA), shortcutRampMat);
    rampA.rotation.x = -angA;
    rampA.position.set(0, 0.585, -9.6);
    rampA.castShadow = true; rampA.receiveShadow = true;
    footrestGroup.add(rampA);

    // Lip traseiro chanfrado ao nível do chão
    const lipA = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W, 0.2, 1.4), shortcutRampMat);
    lipA.position.set(0, 0.1, -14.2);
    lipA.receiveShadow = true;
    footrestGroup.add(lipA);

    // SEÇÃO 2: Placa Central Inclinada do Apoio de Pés (z: -15.2 a -5.2, altura 1.17 a 5.16)
    const lenMid = 10.77, angMid = 0.38;
    const rampMid = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W, 0.5, lenMid), shortcutRampMat);
    rampMid.rotation.x = -angMid;
    rampMid.position.set(0, 3.165, -0.2);
    rampMid.castShadow = true; rampMid.receiveShadow = true;
    footrestGroup.add(rampMid);

    // SEÇÃO 3: Rampa Frontal de Saída Suave (desce suavemente de z: -5.2 a 4.5, altura 5.16 a 0)
    const lenB = 10.99, angB = 0.488;
    const rampB = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W, 0.45, lenB), shortcutRampMat);
    rampB.rotation.x = angB;
    rampB.position.set(0, 2.58, 9.65);
    rampB.castShadow = true; rampB.receiveShadow = true;
    footrestGroup.add(rampB);

    // Lip frontal chanfrado ao nível do chão
    const lipB = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W, 0.2, 1.4), shortcutRampMat);
    lipB.position.set(0, 0.1, 14.7);
    lipB.receiveShadow = true;
    footrestGroup.add(lipB);

    // GUARDRAILS / ABAS LATERAIS CONTÍNUAS DE PAPELÃO COM FAIXA ZEBRADA
    [-RAMP_W / 2, RAMP_W / 2].forEach((sideX) => {
      // Aba da Seção 1
      const railA = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK, RAIL_H, lenA), rampMat);
      railA.rotation.x = -angA;
      railA.position.set(sideX, 0.585 + RAIL_H / 2 - 0.2, -9.6);
      railA.castShadow = true;
      footrestGroup.add(railA);

      const tapeA = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK + 0.05, 0.35, lenA), cautionTapeMat);
      tapeA.rotation.x = -angA;
      tapeA.position.set(sideX, 0.585 + RAIL_H - 0.2, -9.6);
      footrestGroup.add(tapeA);

      // Aba da Seção 2
      const railMid = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK, RAIL_H, lenMid), rampMat);
      railMid.rotation.x = -angMid;
      railMid.position.set(sideX, 3.165 + RAIL_H / 2 - 0.2, -0.2);
      railMid.castShadow = true;
      footrestGroup.add(railMid);

      const tapeMid = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK + 0.05, 0.35, lenMid), cautionTapeMat);
      tapeMid.rotation.x = -angMid;
      tapeMid.position.set(sideX, 3.165 + RAIL_H - 0.2, -0.2);
      footrestGroup.add(tapeMid);

      // Aba da Seção 3
      const railB = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK, RAIL_H, lenB), rampMat);
      railB.rotation.x = angB;
      railB.position.set(sideX, 2.58 + RAIL_H / 2 - 0.2, 9.65);
      railB.castShadow = true;
      footrestGroup.add(railB);

      const tapeB = new THREE.Mesh(new THREE.BoxGeometry(RAIL_THICK + 0.05, 0.35, lenB), cautionTapeMat);
      tapeB.rotation.x = angB;
      tapeB.position.set(sideX, 2.58 + RAIL_H - 0.2, 9.65);
      footrestGroup.add(tapeB);
    });

    bedroomWorld.add(footrestGroup);
    footrestGroup.traverse(m => { if (m.isMesh) occluderMeshes.push(m); });

    // 6. GRANDE VASO OVAL COM DRACENA / YUCCA E ARGILA EXPANDIDA (Ao Lado Direito da Mesa!)
    const bigPlantGroup = new THREE.Group();
    bigPlantGroup.position.set(113, -36.0, 82); // canto frente-direita do quarto (a parede direita agora tem a cama)

    // Vaso Oval / Cápsula em Tom Grafite Fosco
    const planterMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.75 });
    const planterBody = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 7.4, 9.8, 32), planterMat);
    planterBody.scale.set(1.4, 1.0, 0.85); // Formato oval/alongado
    planterBody.position.y = 4.9;
    planterBody.castShadow = true;
    bigPlantGroup.add(planterBody);

    // Revestimento superior de Argila Expandida (Bolinhas de Argila Terracota!)
    const clayTop = new THREE.Mesh(
      new THREE.CylinderGeometry(8.2, 8.2, 0.6, 32),
      new THREE.MeshStandardMaterial({ map: createClayPebblesTexture(), roughness: 0.9 })
    );
    clayTop.scale.set(1.38, 1.0, 0.84);
    clayTop.position.y = 9.8;
    bigPlantGroup.add(clayTop);

    // 2 Troncos Amadeirados de Yucca/Dracena Amarrados com Barbante (Exatos da Foto!)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a412a, roughness: 0.92 });
    const stringMat = new THREE.MeshStandardMaterial({ color: 0xd5cca8, roughness: 0.8 });

    // Tronco Alto (34 unidades de altura)
    const trunkTall = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.1, 34, 16), trunkMat);
    trunkTall.position.set(-2.5, 23.5, 0);
    trunkTall.rotation.z = 0.04;
    trunkTall.castShadow = true;

    // Tronco Médio (24 unidades de altura)
    const trunkShort = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.0, 24, 16), trunkMat);
    trunkShort.position.set(2.5, 18.5, 0);
    trunkShort.rotation.z = -0.04;
    trunkShort.castShadow = true;

    // Amarras de barbante claro segurando os troncos
    [16, 24].forEach((sy) => {
      const twine = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.22, 8, 20), stringMat);
      twine.rotation.x = Math.PI / 2;
      twine.position.set(0, sy, 0);
      bigPlantGroup.add(twine);
    });

    bigPlantGroup.add(trunkTall, trunkShort);

    // Copa Verde Radiante com Folhas Longas e Pontiagudas
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x1f7a36, roughness: 0.45 });
    function createDracaenaCrown(cx, cy, cz, count, radius) {
      const crown = new THREE.Group();
      crown.position.set(cx, cy, cz);
      for (let i = 0; i < count; i++) {
        const phi = (i / count) * Math.PI * 2;
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.35, radius, 0.08), leafMat);
        leaf.rotation.z = Math.sin(phi) * 0.78;
        leaf.rotation.x = Math.cos(phi) * 0.78;
        leaf.position.set(Math.sin(phi) * (radius * 0.35), radius * 0.45, Math.cos(phi) * (radius * 0.35));
        crown.add(leaf);
      }
      return crown;
    }
    const crownTall = createDracaenaCrown(-2.5, 38.0, 0, 28, 12.5);
    const crownShort = createDracaenaCrown(2.5, 29.0, 0, 22, 10.0);
    bigPlantGroup.add(crownTall, crownShort);

    bedroomWorld.add(bigPlantGroup);
    bigPlantGroup.traverse(m => { if (m.isMesh) occluderMeshes.push(m); });
    obstacles.push({ x: 113, z: 82, r: 8.5, name: 'VASO COM YUCCA/DRACENA E ARGILA', isStatic: true, level: 'floor' });

    // Registra a grande planta do quarto como regável!
    growablePlants.push({
      mesh: bigPlantGroup,
      name: 'Yucca / Dracena do Quarto',
      x: 113, z: 82, initX: 113, initZ: 82,
      onFloor: true,
      foliageGroup: null, flowersGroup: null, // cresce pelas copas (foliageMeshes)
      isWatered: false,
      growthElapsed: 0,
      level: 1,
      foliageMeshes: [crownTall, crownShort]
    });

    // 7. CESTO DE LIXO DE ESCRITÓRIO EM FELTRO CINZA (Sob a Mesa à Direita)
    const trashBinGroup = new THREE.Group();
    trashBinGroup.position.set(45, -36.0, -63); // junto à parede do fundo, fora do circuito
    const binMat = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.95 });
    const binMesh = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 2.8, 8.5, 24, 1, true), binMat);
    binMesh.position.y = 4.25;
    binMesh.castShadow = true;
    trashBinGroup.add(binMesh);
    // Bolinha de papel amassado branco dentro do cesto
    const paperBall = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.2, 1),
      new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.9 })
    );
    paperBall.position.set(0.4, 2.8, 0.3);
    trashBinGroup.add(paperBall);
    bedroomWorld.add(trashBinGroup);
    obstacles.push({ x: 45, z: -63, r: 3.8, name: 'CESTO DE LIXO', isStatic: true, level: 'floor' });

    // 8. FILTRO DE LINHA / RÉGUA DE TOMADAS COM CHAVE VERMELHA ILUMINADA
    const powerStripGroup = new THREE.Group();
    powerStripGroup.position.set(18, -35.9, -22);
    const stripMat = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.4 });
    const stripBody = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1.2, 16.0), stripMat);
    stripBody.position.y = 0.6;
    powerStripGroup.add(stripBody);
    // 6 Tomadas em relevo
    for (let i = -2.5; i <= 2.5; i++) {
      const outlet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, 0.15, 16),
        new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.6 })
      );
      outlet.position.set(0, 1.22, i * 2.5);
      powerStripGroup.add(outlet);
    }
    // Chave gangorra com LED vermelho aceso
    const switchRed = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.4, 1.8),
      new THREE.MeshBasicMaterial({ color: 0xff2200 })
    );
    switchRed.position.set(0, 1.35, -6.8);
    // Sem PointLight aqui: uma luz real a menos em TODOS os materiais PBR (o LED já é MeshBasic vermelho)
    powerStripGroup.add(switchRed);
    bedroomWorld.add(powerStripGroup);
    // Objeto fixo: o carrinho bate (antes atravessava). Baixinho: dá para pular por cima.
    obstacles.push({ x: 18, z: -22, r: 8.2, box: { hx: 2.25, hz: 8.0 }, boxRot: 0, name: 'FILTRO DE LINHA', isStatic: true, level: 'floor', h: 1.45 });

    // 9. PAINEL PERFURADO (PEGBOARD) PRETO NA PAREDE ESQUERDA
    const pegboardGroup = new THREE.Group();
    pegboardGroup.position.set(-168, 10, -10); // Fixado rente à parede esquerda do quarto!
    const pegMat = new THREE.MeshStandardMaterial({ map: createPegboardTexture(), roughness: 0.8 });
    const pegBoard = new THREE.Mesh(new THREE.BoxGeometry(0.8, 38, 26), pegMat);
    pegboardGroup.add(pegBoard);
    // Headset gamer pendurado no pegboard
    const headsetBand = new THREE.Mesh(
      new THREE.TorusGeometry(3.8, 0.5, 12, 24, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.4 })
    );
    headsetBand.rotation.y = Math.PI / 2;
    headsetBand.position.set(1.4, 6, -2);
    pegboardGroup.add(headsetBand);
    bedroomWorld.add(pegboardGroup);

    // ============================================================================
    // LISTA DE OBSTÁCULOS E OBJETOS INTERATIVOS DA MESA
    // ============================================================================
    // obstacles already declared

    // ---------- Líquidos animados (água do copo, aquário e café) ----------
    const liquidUniforms = { uTime: { value: 0 } };
    // Padrão de "cáusticas" (luz refratada pela água) feito com senos entrelaçados
    const GLSL_CAUSTIC = `
      float caustic(vec2 p, float t) {
        float v = 0.0;
        v += sin(p.x * 3.1 + t * 1.3 + sin(p.y * 2.7 + t));
        v += sin(p.y * 3.7 - t * 1.1 + sin(p.x * 2.3 - t * 0.7));
        v += sin((p.x + p.y) * 2.9 + t * 0.9 + sin(p.x * 1.7 - t * 0.5));
        v /= 3.0;
        return pow(1.0 - abs(v), 5.0);
      }`;
    // Superfície redonda de água (copo): ondas concêntricas, cáusticas, menisco claro na borda e reflexo
    function createRoundWaterMaterial(deep, shallow) {
      return new THREE.ShaderMaterial({
        uniforms: { uTime: liquidUniforms.uTime, uDeep: { value: new THREE.Color(deep) }, uShallow: { value: new THREE.Color(shallow) }, uAgitation: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform float uAgitation;
          varying vec2 vUv;
          ${GLSL_CAUSTIC}
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            float ring = sin(r * (16.0 + uAgitation * 10.0) - uTime * (3.0 + uAgitation * 6.0)) * 0.5 + 0.5;
            ring *= (1.0 - r) * (0.25 + uAgitation);
            float c = caustic(p * 2.6, uTime * 1.2);
            vec3 col = mix(uDeep, uShallow, 0.3 + 0.45 * c + 0.35 * ring);
            float rim = smoothstep(0.78, 0.98, r);
            col = mix(col, vec3(0.92, 1.0, 1.0), rim * 0.6);
            float spec = pow(max(0.0, 1.0 - length(p - vec2(-0.38, 0.32)) * 2.4), 5.0);
            col += spec * 0.7;
            gl_FragColor = vec4(col, 0.94);
          }`,
        transparent: true
      });
    }

    // 1. COPO TÉRMICO STANLEY BRANCO COM ÁGUA (Borda Inox, Tampa Translúcida, Canudo e Logo!)
    const tumblerGroup = new THREE.Group();
    const tumblerPivot = new THREE.Group(); // Pivô na base para tombar!
    tumblerGroup.add(tumblerPivot);

    const inoxMat = new THREE.MeshStandardMaterial({ color: 0xd6dde4, metalness: 0.88, roughness: 0.16 });
    const tumblerBaseInox = new THREE.Mesh(new THREE.CylinderGeometry(1.46, 1.40, 0.55, 28), inoxMat);
    tumblerBaseInox.position.y = 0.28;
    tumblerPivot.add(tumblerBaseInox);

    const tumblerBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.95, 1.46, 5.5, 28),
      new THREE.MeshStandardMaterial({ color: 0xf4f6f9, roughness: 0.22 })
    );
    tumblerBody.position.y = 3.3;
    tumblerBody.castShadow = true;
    tumblerPivot.add(tumblerBody);

    // Borda aberta (tubo): o cilindro fechado tampava a água do copo
    const tumblerTopRim = new THREE.Mesh(new THREE.CylinderGeometry(1.99, 1.95, 0.45, 28, 1, true), inoxMat.clone());
    tumblerTopRim.material.side = THREE.DoubleSide;
    tumblerTopRim.position.y = 6.22;
    tumblerPivot.add(tumblerTopRim);

    // Superfície da água do copo (shader com ondinhas; agita quando o carrinho chega perto)
    const cupWaterMat = createRoundWaterMaterial(0x0a7fb8, 0x6fe3ff);
    const cupWaterInside = new THREE.Mesh(new THREE.CircleGeometry(1.84, 40), cupWaterMat);
    cupWaterInside.rotation.x = -Math.PI / 2;
    cupWaterInside.position.y = 6.3;
    tumblerPivot.add(cupWaterInside);

    // Tampa acrílica translúcida + Canudo reutilizável
    const cupLid = new THREE.Mesh(
      new THREE.CylinderGeometry(1.96, 1.96, 0.22, 28),
      new THREE.MeshStandardMaterial({ color: 0xe8f4f8, transparent: true, opacity: 0.2, roughness: 0.05, depthWrite: false })
    );
    cupLid.position.y = 6.52;
    const cupStraw = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 2.2, 16),
      new THREE.MeshStandardMaterial({ color: 0x35e0ff, roughness: 0.2 })
    );
    cupStraw.position.set(0.25, 7.2, 0.15);
    cupStraw.rotation.z = -0.18;
    tumblerPivot.add(cupLid, cupStraw);

    tumblerGroup.position.set(-26, 0.14, 14); // apoiado no tampo (antes ficava 0,14 afundado)
    deskWorld.add(tumblerGroup);

    // Poça de água derramada (inicialmente invisível / escala zero)
    const puddleMesh = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 36),
      new THREE.MeshStandardMaterial({
        color: 0x24c8ff,
        roughness: 0.08,
        metalness: 0.15,
        transparent: true,
        opacity: 0.78
      })
    );
    puddleMesh.rotation.x = -Math.PI / 2;
    puddleMesh.position.set(-20.5, 0.16, 14);
    puddleMesh.scale.set(0.001, 0.001, 0.001);
    puddleMesh.visible = false;
    deskWorld.add(puddleMesh);

    let cupSpilled = false;
    let puddleScale = 0.001;
    const cupObstacle = registerDynamicObstacle({
      obs: {
        x: -26, z: 14, r: 2.35,
        name: 'COPO COM ÁGUA (BATA PARA DERRAMAR E ABASTECER!)',
        type: 'water_cup'
      },
      group: tumblerGroup,
      mass: 0.85,
      canTopple: false // o tombo do copo é feito pela animação própria (gira pela quina da base)
    });

    // ---------- Tombo do copo: gira pela QUINA da base no sentido da batida (nunca entra na mesa) ----------
    // Geometria: base r=1.46 (y=0), boca r=1.99 (y=6.45). Deitado, a lateral encosta na mesa:
    // ângulo de repouso = 90° − inclinação da lateral.
    // Quina de apoio = borda inferior da base de inox (r=1.40). Repouso calculado pelo ponto que encosta primeiro
    // (quina superior da base inox x corpo: atan(0.555 / 0.06) ≈ 1.463 rad), com folga.
    const CUP_BASE_R = 1.40, CUP_TOP_R = 1.99, CUP_H = 6.45;
    const CUP_REST_ANGLE = 1.455;
    const cupFall = { active: false, theta: 0, omega: 0, bounced: false, dirX: 1, dirZ: 0, settled: false, splashT: 0 };
    const _cupQ = new THREE.Quaternion(), _cupAxis = new THREE.Vector3(0, 0, -1), _cupE = new THREE.Vector3(CUP_BASE_R, 0, 0);
    function applyCupTilt(theta) {
      // Rotação em torno do eixo z local (negativo = tomba para +x local) com pivô na quina E=(1.46,0,0)
      _cupQ.setFromAxisAngle(_cupAxis, theta);
      tumblerPivot.quaternion.copy(_cupQ);
      const re = _cupE.clone().applyQuaternion(_cupQ);
      tumblerPivot.position.set(_cupE.x - re.x + (cupFall.shiftX || 0), _cupE.y - re.y, _cupE.z - re.z);
    }
    function spillCup(dx, dz) {
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      cupSpilled = true;
      Object.assign(cupFall, { active: true, theta: 0.04, omega: 1.2, bounced: false, dirX: dx, dirZ: dz, settled: false, splashT: 0, shiftX: 0 });
      // Gira o grupo para que o +x local aponte para a direção da queda
      tumblerGroup.rotation.y = Math.atan2(-dz, dx);
      cupObstacle.vRotY = 0;
      cupWaterInside.visible = false;
      // Poça nasce na frente da boca do copo, alongada no sentido do tombo
      const base = tumblerGroup.position;
      let px = base.x + dx * (CUP_H + CUP_BASE_R + 2.2), pz = base.z + dz * (CUP_H + CUP_BASE_R + 2.2);
      px = clamp(px, -DESK_HALF_W + 7, DESK_HALF_W - 7); pz = clamp(pz, -DESK_HALF_D + 7, DESK_HALF_D - 7);
      puddleMesh.position.set(px, puddleMesh.position.y, pz);
      puddleMesh.rotation.y = Math.atan2(-dz, dx);
      puddleScale = 0.001;
      puddleMesh.visible = true;
    }
    function updateCupFall(dt) {
      if (!cupFall.active) return;
      if (!cupFall.settled) {
        // Gravidade puxa mais quanto mais inclinado (como um pêndulo invertido)
        cupFall.omega += (2.5 + 14 * Math.sin(cupFall.theta)) * dt;
        cupFall.theta += cupFall.omega * dt;
        if (cupFall.theta >= CUP_REST_ANGLE) {
          cupFall.theta = CUP_REST_ANGLE;
          if (!cupFall.bounced && cupFall.omega > 1.5) { cupFall.omega = -cupFall.omega * 0.18; cupFall.bounced = true; playImpactSound(cupObstacle, 0.3, 1); }
          else {
            cupFall.settled = true;
            // Deitado: o colisor vira uma caixa do tamanho do copo, centrada no corpo dele
            const bodyMid = new THREE.Vector3(0, CUP_H * 0.5, 0).sub(_cupE).applyQuaternion(_cupQ).add(_cupE);
            const shift = bodyMid.x;
            cupFall.shiftX = -shift;
            const c = Math.cos(tumblerGroup.rotation.y), s = Math.sin(tumblerGroup.rotation.y);
            cupObstacle.x += shift * c; cupObstacle.z -= shift * s;
            cupObstacle._px = cupObstacle.x; cupObstacle._pz = cupObstacle.z;
            tumblerGroup.position.x = cupObstacle.x; tumblerGroup.position.z = cupObstacle.z;
            cupObstacle.box = { hx: CUP_H / 2 + 0.2, hz: CUP_TOP_R };
            cupObstacle.r = Math.hypot(cupObstacle.box.hx, cupObstacle.box.hz) * 0.75;
          }
        }
        applyCupTilt(cupFall.theta);
        // Água jorra pela boca na direção do tombo enquanto o copo cai
        if (cupFall.theta > 0.7 && cupFall.splashT < 0.6) {
          cupFall.splashT += dt;
          const mouth = new THREE.Vector3(0, CUP_H, 0).sub(_cupE).applyQuaternion(_cupQ).add(_cupE).applyMatrix4(tumblerGroup.matrixWorld);
          for (let i = 0; i < 3; i++) {
            spawnFx(mouth.x, mouth.y, mouth.z,
              cupFall.dirX * (5 + Math.random() * 4) + (Math.random() - 0.5) * 2, 1 + Math.random() * 2.5,
              cupFall.dirZ * (5 + Math.random() * 4) + (Math.random() - 0.5) * 2, 0x6fe3ff, 0.32, 18, 0.7);
          }
        }
      }
    }
    function resetCupFall() {
      Object.assign(cupFall, { active: false, theta: 0, omega: 0, settled: false, shiftX: 0 });
      tumblerPivot.quaternion.identity();
      tumblerPivot.position.set(0, 0, 0);
      tumblerPivot.rotation.set(0, 0, 0);
      tumblerGroup.rotation.set(0, 0, 0);
      cupObstacle.box = null;
      cupObstacle.r = 2.35;
      puddleMesh.position.set(-20.5, puddleMesh.position.y, 14);
      puddleMesh.rotation.y = 0;
    }

    // 2 & 3. SUPORTE ARTICULADO A GÁS DUPLO (DUAL ARM COM MORSA NA MESA) + NOTEBOOK ACER NITRO V 15 + MONITOR LG ULTRAGEAR™ 45"
    // ============================================================================
    const dualArmGroup = new THREE.Group();
    const armMat = new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.35, metalness: 0.5 });
    const armGlossMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.15, metalness: 0.4 });
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.8 });

    // Base de Fixação com Morsa (C-Clamp) na borda traseira da mesa
    const clampBase = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.85, 3.8), armMat);
    clampBase.position.set(-4.5, 0.42, -20.2);
    clampBase.castShadow = true;
    const clampLip = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.2, 0.9), armMat);
    clampLip.position.set(-4.5, -0.9, -21.6);
    const clampScrew = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.4, 16), armGlossMat);
    clampScrew.position.set(-4.5, -1.6, -20.4);
    const clampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.92, 5.2, 24), armMat);
    clampPost.position.set(-4.5, 2.8, -20.2);
    clampPost.castShadow = true;
    dualArmGroup.add(clampBase, clampLip, clampScrew, clampPost);

    // --- BRAÇO 1 (DIREITO) -> Segura o Monitor LG UltraGear 45" Curvo por VESA 100x100 ---
    const arm1Swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.2, 20), armGlossMat);
    arm1Swivel.position.set(-4.5, 4.4, -20.2);
    const arm1Lower = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 7.8), armMat);
    arm1Lower.position.set(-0.8, 4.6, -18.2);
    arm1Lower.rotation.y = 0.52;
    arm1Lower.castShadow = true;
    const arm1Elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 1.35, 20), armGlossMat);
    arm1Elbow.position.set(2.4, 4.6, -15.5);
    // Pistão / Braço Superior a Gás inclinado subindo até o VESA
    const arm1Upper = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.3, 7.2), armMat);
    arm1Upper.position.set(4.2, 7.2, -14.6);
    arm1Upper.rotation.x = -0.42;
    arm1Upper.rotation.y = 0.35;
    arm1Upper.castShadow = true;
    // Etiqueta Triangular Amarela de Aviso "⚠️ Spring Tension" no cotovelo do braço do monitor!
    const warningMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ map: createWarningStickerTexture(), transparent: true })
    );
    warningMesh.position.set(2.95, 5.3, -15.2);
    warningMesh.rotation.y = 0.45;
    // Cabeça VESA articulada
    const vesaHead = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 0.6), armGlossMat);
    vesaHead.position.set(6.5, 9.2, -13.6);
    dualArmGroup.add(arm1Swivel, arm1Lower, arm1Elbow, arm1Upper, warningMesh, vesaHead);

    // Cabos do monitor descendo pelo braço articulado
    const monCable1 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 8.5, 8), cableMat);
    monCable1.position.set(4.4, 6.8, -14.3);
    monCable1.rotation.x = -0.42; monCable1.rotation.y = 0.35;
    const monCable2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 7.6, 8), cableMat);
    monCable2.position.set(-0.6, 4.2, -18.4);
    monCable2.rotation.y = 0.52;
    dualArmGroup.add(monCable1, monCable2);

    // --- BRAÇO 2 (ESQUERDO) -> Segura a Bandeja Inclinada do Notebook Acer Nitro V 15 ---
    const arm2Swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 1.1, 20), armGlossMat);
    arm2Swivel.position.set(-4.5, 3.2, -20.2);
    const arm2Lower = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.0, 9.2), armMat);
    arm2Lower.position.set(-10.2, 3.4, -17.5);
    arm2Lower.rotation.y = -0.62;
    arm2Lower.castShadow = true;
    const arm2Elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.88, 1.2, 20), armGlossMat);
    arm2Elbow.position.set(-15.4, 3.4, -14.2);
    const arm2Upper = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.1, 7.4), armMat);
    arm2Upper.position.set(-17.6, 3.2, -10.8);
    arm2Upper.rotation.y = 0.28;
    arm2Upper.castShadow = true;
    // Bandeja de aço preto perfurada de suporte do notebook (inclinada)
    const laptopTray = new THREE.Mesh(
      new THREE.BoxGeometry(14.8, 0.32, 10.6),
      new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.45, metalness: 0.6 })
    );
    laptopTray.position.set(-19.0, 2.5, -8.0);
    laptopTray.rotation.x = 0.32;
    laptopTray.rotation.y = 0.24;
    laptopTray.castShadow = true;
    // Abas frontais de retenção da bandeja
    const trayLip = new THREE.Mesh(new THREE.BoxGeometry(14.8, 0.72, 0.26), armMat);
    trayLip.position.set(0, 0.32, 5.25);
    laptopTray.add(trayLip);
    dualArmGroup.add(arm2Swivel, arm2Lower, arm2Elbow, arm2Upper, laptopTray);
    deskWorld.add(dualArmGroup);

    // Correção de design: os segmentos do braço atravessavam a tela do monitor e o corpo do notebook.
    // Agora cada segmento é alinhado entre dois pontos que ficam ATRÁS da tela e ABAIXO da bandeja.
    function alignBoxBetween(mesh, a, b) {
      const len = a.distanceTo(b);
      mesh.geometry.dispose();
      const p = mesh.userData.size || [1.3, 1.1];
      mesh.geometry = new THREE.BoxGeometry(p[0], p[1], len);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.rotation.set(0, 0, 0);
      mesh.lookAt(b);
    }
    function alignCylinderBetween(mesh, a, b) {
      const dir = b.clone().sub(a);
      const len = dir.length();
      mesh.scale.set(1, len / mesh.geometry.parameters.height, 1);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    }
    (function fixMonitorArms() {
      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      // Braço 1 → monitor: base da morsa → cotovelo atrás → placa VESA nas costas da tela
      const a1 = V(-4.5, 4.6, -20.2), e1 = V(1.8, 5.4, -20.8), v1 = V(6.5, 9.2, -16.0);
      arm1Lower.userData.size = [1.4, 1.1]; alignBoxBetween(arm1Lower, a1, e1);
      arm1Elbow.position.copy(e1);
      arm1Upper.userData.size = [1.35, 1.3]; alignBoxBetween(arm1Upper, e1, v1);
      vesaHead.position.set(6.5, 9.2, -14.95);           // atrás da traseira curva (z ≈ -14.35)
      const vesaNeck = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 1.1), armGlossMat);
      vesaNeck.position.set(6.5, 9.2, -15.6);
      dualArmGroup.add(vesaNeck);
      warningMesh.position.copy(a1.clone().lerp(e1, 0.5)).add(V(0, 0.62, 0));
      warningMesh.rotation.set(-Math.PI / 2, 0, 0);
      alignCylinderBetween(monCable1, e1.clone().add(V(0, -0.75, 0)), v1.clone().add(V(0, -0.8, 0)));
      alignCylinderBetween(monCable2, a1.clone().add(V(0, -0.65, 0)), e1.clone().add(V(0, -0.65, 0)));
      // Braço 2 → notebook: passa por baixo da bandeja e sobe por um poste até ela
      const a2 = V(-4.5, 3.0, -20.2), e2 = V(-13.5, 1.6, -18.6), t2 = V(-18.6, 1.3, -11.2);
      arm2Lower.userData.size = [1.3, 1.0]; alignBoxBetween(arm2Lower, a2, e2);
      arm2Elbow.position.copy(e2);
      arm2Upper.userData.size = [1.25, 1.0]; alignBoxBetween(arm2Upper, e2, t2);
      const trayPost = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), armGlossMat);
      alignCylinderBetween(trayPost, t2, V(-18.6, 3.0, -11.2));
      dualArmGroup.add(trayPost);
    })();

    // --- NOTEBOOK ACER NITRO V 15 (Instalado na Bandeja Inclinada do Braço com Cabos Reais!) ---
    const laptopGroup = new THREE.Group();
    const laptopChassisMat = new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.35, metalness: 0.3 });

    const lapBaseGroup = new THREE.Group();
    lapBaseGroup.position.set(0, 0.35, 0);
    const lapDeck = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.48, 10.0), laptopChassisMat);
    lapDeck.castShadow = true; lapBaseGroup.add(lapDeck);

    // Teclado integrado com iluminação vermelha suave no estilo Nitro
    const lapKeys = new THREE.Mesh(new THREE.BoxGeometry(13.1, 0.12, 5.3), new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.5 }));
    lapKeys.position.set(0, 0.26, -1.2); lapBaseGroup.add(lapKeys);
    // Teclas WASD em branco/vermelho características
    const wasdAccent = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.8), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
    wasdAccent.position.set(-4.2, 0.32, -1.2); lapBaseGroup.add(wasdAccent);

    const touchpad = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.06, 2.6), new THREE.MeshStandardMaterial({ color: 0x272b32 }));
    touchpad.position.set(-1.1, 0.26, 3.1); lapBaseGroup.add(touchpad);

    // Adesivos reais no palmrest do notebook (Intel Core, GeForce RTX e Fita do Autismo!)
    const stickerIntel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.65), new THREE.MeshBasicMaterial({ color: 0x0071c5 }));
    stickerIntel.rotation.x = -Math.PI / 2; stickerIntel.position.set(-5.8, 0.28, 2.3);
    const stickerRtx = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.65), new THREE.MeshBasicMaterial({ color: 0x76b900 }));
    stickerRtx.rotation.x = -Math.PI / 2; stickerRtx.position.set(-4.6, 0.28, 2.3);
    const stickerHeart = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: createHeartStickerTexture(), transparent: true }));
    stickerHeart.rotation.x = -Math.PI / 2; stickerHeart.position.set(-5.2, 0.28, 3.7);
    lapBaseGroup.add(stickerIntel, stickerRtx, stickerHeart);

    // Tela do Notebook com Moldura Fina, Adesivo "144Hz" e Webcam no topo
    const lapScreenGroup = new THREE.Group();
    lapScreenGroup.position.set(0, 0.25, -4.9); lapScreenGroup.rotation.x = -0.38;
    const lapLid = new THREE.Mesh(new THREE.BoxGeometry(14.4, 9.4, 0.35), laptopChassisMat);
    lapLid.position.set(0, 4.7, 0); lapLid.castShadow = true; lapScreenGroup.add(lapLid);
    const lapDisplay = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 8.4), new THREE.MeshBasicMaterial({ map: laptopScreenTexture }));
    lapDisplay.position.set(0, 4.7, 0.19); lapScreenGroup.add(lapDisplay);
    // Webcam no topo da moldura
    const lapWebcam = new THREE.Mesh(new THREE.CircleGeometry(0.09, 12), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    lapWebcam.position.set(0, 9.15, 0.19); lapScreenGroup.add(lapWebcam);
    // Selo "144Hz" na moldura inferior esquerda da tela
    const badge144 = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.35), new THREE.MeshBasicMaterial({ color: 0xd4af37 }));
    badge144.position.set(-6.1, 0.42, 0.19); lapScreenGroup.add(badge144);

    lapBaseGroup.add(lapScreenGroup);
    laptopGroup.add(lapBaseGroup);
    laptopGroup.position.set(-19, 2.5, -8);
    laptopGroup.rotation.x = 0.32;
    laptopGroup.rotation.y = 0.24;

    // Teclas de verdade no notebook (teclado ABNT com teclas individuais + barra de espaço)
    (function addLaptopKeycaps() {
      const capGeo = new THREE.BoxGeometry(0.66, 0.1, 0.56);
      const capMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.55 });
      const cols = 15, rows = 5;
      const caps = new THREE.InstancedMesh(capGeo, capMat, cols * rows);
      const m = new THREE.Object3D();
      let n = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          m.position.set(-6.1 + c * 0.86 + (r % 2) * 0.2, 0.37, -3.3 + r * 0.82);
          m.updateMatrix();
          caps.setMatrixAt(n++, m.matrix);
        }
      }
      caps.instanceMatrix.needsUpdate = true;
      const space = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.1, 0.56), capMat);
      space.position.set(-0.6, 0.37, 0.9);
      lapBaseGroup.add(caps, space);
      wasdAccent.position.y = 0.44;
    })();
    deskWorld.add(laptopGroup);
    obstacles.push({ x: -19, z: -8, r: 6.4, box: { hx: 7.6, hz: 5.4 }, boxRot: 0.24, name: 'NOTEBOOK ACER NITRO V 15 NO BRAÇO ARTICULADO' });

    // --- MONITOR LG ULTRAGEAR™ OLED 45" CURVO 800R (Suspenso pelo Braço Articulado a Gás!) ---
    const monitorGroup = new THREE.Group();
    const monitorHeadGroup = new THREE.Group();
    monitorGroup.add(monitorHeadGroup);

    // Curvatura agressiva 800R de 45 polegadas!
    const curveRadius = 22.5, arcAngle = 1.08, monitorHeight = 11.4;
    const curvedBackGeo = new THREE.CylinderGeometry(curveRadius + 0.35, curveRadius + 0.35, monitorHeight, 56, 1, true, Math.PI - arcAngle / 2, arcAngle);
    const curvedBackMat = new THREE.MeshStandardMaterial({ color: 0x131519, roughness: 0.35, side: THREE.DoubleSide });
    const curvedBack = new THREE.Mesh(curvedBackGeo, curvedBackMat);
    curvedBack.position.set(0, 9.2, curveRadius - 1.5);
    curvedBack.castShadow = true;
    monitorHeadGroup.add(curvedBack);

    const curvedScreenGeo = new THREE.CylinderGeometry(curveRadius, curveRadius, monitorHeight - 0.38, 56, 1, true, Math.PI - arcAngle / 2, arcAngle);
    const uvAttr = curvedScreenGeo.attributes.uv;
    for (let i = 0; i < uvAttr.count; i++) uvAttr.setX(i, 1 - uvAttr.getX(i));
    const curvedScreen = new THREE.Mesh(curvedScreenGeo, new THREE.MeshBasicMaterial({ map: monitorTexture, side: THREE.BackSide }));
    curvedScreen.position.set(0, 9.2, curveRadius - 1.45);
    monitorHeadGroup.add(curvedScreen);

    // Chamas 3D do Monitor (visíveis quando em autodestruição!)
    const monitorFireGroup = new THREE.Group();
    monitorFireGroup.position.set(0, 9.8, -1.2);
    monitorFireGroup.visible = false;
    const fireCones = [];
    for (let i = 0; i < 14; i++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.9 + Math.random() * 0.7, 3.2 + Math.random() * 2.0, 7),
        new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xff4500 : 0xffbe00 })
      );
      cone.position.set((i - 6.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.2);
      monitorFireGroup.add(cone);
      fireCones.push(cone);
    }
    const fireLight = new THREE.PointLight(0xff5500, 0, 35);
    fireLight.position.set(0, 4, 3);
    monitorFireGroup.add(fireLight);
    monitorGroup.add(monitorFireGroup);

    monitorGroup.position.set(6.5, 0, -12.5);
    deskWorld.add(monitorGroup);
    obstacles.push({ x: 6.5, z: -14.3, r: 3.4, name: 'MONITOR LG ULTRAGEAR™ OLED 45" CURVO 800R' });

    // 4. CONTROLES DE VIDEOGAME (XBOX & PS5 DUALSENSE) — 5 ESTÁGIOS DE QUEBRA (ATÉ 20 BATIDAS!)
    const controllerDebrisList = [];
    const breakableControllers = [];

    const CONTROLLER_SCALE = 1.75;
    function createBreakableGamepad(name, x, z, rotY, colorHex, accentHex, isPS5 = false) {
      const gp = new THREE.Group();
      gp.position.set(x, 0.14, z);
      gp.rotation.y = rotY;

      const bodyMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.32 });
      const darkMat = new THREE.MeshStandardMaterial({ color: accentHex, roughness: 0.42 });

      // Corpo central ergonômico abaulado
      const centerBody = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.62, 1.52), bodyMat);
      centerBody.position.y = 0.46;
      centerBody.castShadow = true;
      gp.add(centerBody);

      // Botões de ombro (Bumpers L1 / R1) na borda traseira frontal do controle
      [-0.85, 0.85].forEach((bx) => {
        const bumper = new THREE.Mesh(
          new THREE.BoxGeometry(0.68, 0.22, 0.25),
          new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.3 })
        );
        bumper.position.set(bx, 0.62, -0.74);
        gp.add(bumper);
      });

      if (isPS5) {
        // Touchpad trapezoidal preto acetinado + Barras de LED Ciano laterais do DualSense + Detalhe inferior preto
        const touch = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.66, 0.88), darkMat);
        touch.position.set(0, 0.48, -0.22);
        const ledBar = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.64, 0.90), new THREE.MeshBasicMaterial({ color: 0x00b4d8 }));
        ledBar.position.set(0, 0.47, -0.22);
        const lowerTrim = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.63, 0.72), darkMat);
        lowerTrim.position.set(0, 0.46, 0.42);

        // Botão PlayStation (Logo PS) estilizado entre os analógicos
        const psBtn = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.18), darkMat);
        psBtn.position.set(0, 0.79, 0.28);
        // Botão horizontal de Mute do microfone com ponto LED âmbar
        const muteBtn = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.09), darkMat);
        muteBtn.position.set(0, 0.79, 0.46);
        const muteLed = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.04), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
        muteLed.position.set(0, 0.80, 0.46);

        // Pinos de carregamento de dock dourados e fone P2 na frente inferior
        const dockPins = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.08), new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8 }));
        dockPins.position.set(0, 0.24, 0.74);

        // Porta USB-C na parte traseira
        const usbcPort = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.12), new THREE.MeshBasicMaterial({ color: 0x090a0c }));
        usbcPort.position.set(0, 0.58, -0.76);

        gp.add(ledBar, touch, lowerTrim, psBtn, muteBtn, muteLed, dockPins, usbcPort);
      } else {
        // Botão Xbox Nexus iluminado em branco no topo central
        const xboxBtn = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        xboxBtn.position.set(0, 0.79, -0.45);
        gp.add(xboxBtn);
      }

      // D-Pad em Cruz (+)
      const dpadX = isPS5 ? -0.92 : -0.46;
      const dpadZ = isPS5 ? -0.15 : 0.34;
      const dpadH = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.15), darkMat);
      dpadH.position.set(dpadX, 0.78, dpadZ);
      const dpadV = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.46), darkMat);
      dpadV.position.set(dpadX, 0.78, dpadZ);
      gp.add(dpadH, dpadV);

      // 4 Botões de Ação (ABXY coloridos no Xbox / Botões translúcidos claros no PS5)
      const abxyColors = isPS5
        ? [0xdde3ea, 0xdde3ea, 0xdde3ea, 0xdde3ea]
        : [0xfbc02d, 0xe53935, 0x43a047, 0x1e88e5]; // Y (cima), B (dir), A (baixo), X (esq)
      const btnOffsets = [[0, -0.22], [0.22, 0], [0, 0.22], [-0.22, 0]];
      btnOffsets.forEach(([ox, oz], idx) => {
        const abtn = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.09, 0.12, 12),
          new THREE.MeshStandardMaterial({ color: abxyColors[idx], roughness: 0.2 })
        );
        abtn.position.set(0.92 + ox, 0.78, -0.15 + oz);
        gp.add(abtn);
      });

      // Grips laterais ergonômicos com pontas arredondadas
      const gripGeo = new THREE.CylinderGeometry(0.44, 0.28, 2.35, 16);
      const gripL = new THREE.Mesh(gripGeo, bodyMat);
      gripL.rotation.x = Math.PI / 2.25; gripL.rotation.z = 0.24;
      gripL.position.set(-1.24, 0.38, 0.42); gripL.castShadow = true;

      const gripR = new THREE.Mesh(gripGeo, bodyMat);
      gripR.rotation.x = Math.PI / 2.25; gripR.rotation.z = -0.24;
      gripR.position.set(1.24, 0.38, 0.42); gripR.castShadow = true;
      gp.add(gripL, gripR);

      // Analógicos com cabeça côncava emborrachada
      function createThumbstick(sx, sz) {
        const sGroup = new THREE.Group();
        sGroup.position.set(sx, 0.78, sz);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.28, 12), darkMat);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.22, 0.09, 18), darkMat);
        cap.position.y = 0.15;
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 8, 18), darkMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.19;
        sGroup.add(post, cap, rim);
        return sGroup;
      }
      const stickL = createThumbstick(isPS5 ? -0.52 : -0.86, isPS5 ? 0.34 : -0.15);
      const stickR = createThumbstick(0.52, 0.34);
      gp.add(stickL, stickR);

      // Tamanho real em relação à caneca (DualSense ~16 cm x caneca ~10 cm)
      gp.scale.setScalar(CONTROLLER_SCALE);
      deskWorld.add(gp);

      const ctrlObj = {
        name,
        group: gp,
        initX: x, initZ: z, initRotY: rotY,
        origColor: colorHex,
        bodyMat,
        centerBody, gripL, gripR, stickL, stickR,
        hits: 0,
        stage: 0,
        lastHitTime: 0,
        obs: {
          x, z, r: 2.0 * CONTROLLER_SCALE,
          name: `${name} (INTACTO - BATA ATÉ 20X PARA QUEBRAR!)`,
          type: 'controller',
          ctrlRef: null
        }
      };
      ctrlObj.obs.ctrlRef = ctrlObj;
      registerDynamicObstacle({ obs: ctrlObj.obs, group: gp, mass: 1.35, canTopple: true });
      breakableControllers.push(ctrlObj);
    }

    createBreakableGamepad('CONTROLE PS5 PRO MIDNIGHT BLACK', 25.0, 11.5, -0.45, 0x16181b, 0x111214, true);

    function hitController(ctrl, impactSpeed) {
      const now = performance.now();
      if (now - ctrl.lastHitTime < 240) return;
      ctrl.lastHitTime = now;

      // O impulso físico do empurrão é aplicado pela colisão carro-objeto (stepVehicle)
      if (ctrl.stage >= 4) {
        setStatusBanner(`💥 ${ctrl.name} já quebrou todas as 4 partes!`, '#ff5722');
        return;
      }

      ctrl.hits++;
      const currentPartHits = ctrl.hits % 10;
      const hitsNeeded = 10;

      // Feedback sonoro/visual
      showCarSpeech(breakSpeechToggle ? 'eita' : 'ops', 1800);
      breakSpeechToggle = !breakSpeechToggle;

      if (currentPartHits === 0) {
        // Atingiu a resistência de 10 batidas: quebra a próxima parte!
        ctrl.stage = Math.min(4, ctrl.stage + 1);

        // Solta pedacinhos do controle na mesa/quarto
        const pieceColors = [ctrl.origColor, 0x181a1e, 0x00e5ff, 0xff4081, 0xffeb3b];
        for (let i = 0; i < 5; i++) {
          const piece = new THREE.Mesh(
            new THREE.BoxGeometry(0.35 + Math.random() * 0.25, 0.18, 0.35 + Math.random() * 0.25),
            new THREE.MeshStandardMaterial({ color: pieceColors[i % pieceColors.length], roughness: 0.4 })
          );
          const ang = Math.random() * Math.PI * 2;
          const dist = 1.6 + Math.random() * 2.5;
          piece.position.set(
            ctrl.group.position.x + Math.cos(ang) * dist,
            surfaceBaseY(ctrl.group.position.y) + 0.22,
            ctrl.group.position.z + Math.sin(ang) * dist
          );
          piece.rotation.set(Math.random(), Math.random(), Math.random());
          piece.castShadow = true;
          deskWorld.add(piece);
          controllerDebrisList.push(piece);
        }

        // Aplica os 4 estágios de quebra
        if (ctrl.stage === 1) {
          ctrl.stickL.visible = false; // Parte 1: solta o analógico esquerdo
          ctrl.centerBody.rotation.z = 0.08;
        } else if (ctrl.stage === 2) {
          ctrl.stickR.visible = false; // Parte 2: solta o analógico direito
          ctrl.gripL.position.x = -1.45;
          ctrl.gripL.rotation.z = 0.55;
        } else if (ctrl.stage === 3) {
          ctrl.gripL.visible = false; // Parte 3: quebra o grip esquerdo
          ctrl.gripR.position.x = 1.45;
          ctrl.gripR.rotation.z = -0.55;
        } else if (ctrl.stage >= 4) {
          ctrl.gripR.visible = false; // Parte 4: quebra o grip direito e racha o corpo
          ctrl.centerBody.scale.set(0.68, 0.5, 0.68);
          ctrl.centerBody.rotation.set(0.2, 0.35, -0.15);
          ctrl.bodyMat.color.setHex(0x383232);
          if (typeof unlockAchievement === 'function') unlockAchievement('destroyer');
        }

        setStatusBanner(`🚨 ${ctrl.name}: QUEBROU A PARTE ${ctrl.stage} DE 4! (Após 10 impactos)`, '#f44336');
        logInteractionEvent(`🚨 ${ctrl.name}: Parte ${ctrl.stage}/4 quebrada após 10 impactos!`);
      } else {
        setStatusBanner(`💥 ${ctrl.name}: Resistência ${currentPartHits}/10 batidas para quebrar a Parte ${ctrl.stage + 1}/4!`, '#ffb300');
      }

      ctrl.obs.name = `${ctrl.name} — PARTE ${ctrl.stage}/4 QUEBRADA (${ctrl.hits % 10}/10 IMPACTOS)`;
    }

    // 5. TECLADO GAMER LOGITECH G213 PRODIGY (Descanso de Pulso Integrado + Adesivo Copilot + Iluminação ABNT2!)
    const kbGroup = new THREE.Group();
    const kbBaseMat = new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.45 });
    const kbDeckMat = new THREE.MeshStandardMaterial({
      map: createG213DeckTexture(),
      roughness: 0.35,
      metalness: 0.25
    });

    // Chassi inteiriço com perfil ergonômico do G213 Prodigy
    const kbChassis = new THREE.Mesh(new THREE.BoxGeometry(16.8, 0.42, 8.4), kbBaseMat);
    kbChassis.position.set(0, 0.21, 0.1);
    kbChassis.castShadow = true;
    kbChassis.receiveShadow = true;
    kbGroup.add(kbChassis);

    // Placa superior com chanfro e textura das marcações G213
    const kbTopPlate = new THREE.Mesh(new THREE.BoxGeometry(16.6, 0.12, 8.2), kbDeckMat);
    kbTopPlate.position.set(0, 0.43, 0.1);
    kbTopPlate.receiveShadow = true;
    kbGroup.add(kbTopPlate);

    // Apoio de Pulso Integrado com Caimento Ergonômico Suave para Frente
    const wristRest = new THREE.Mesh(new THREE.BoxGeometry(16.6, 0.32, 2.9), kbBaseMat);
    wristRest.position.set(0, 0.22, 2.95);
    wristRest.rotation.x = 0.08;
    kbGroup.add(wristRest);

    // Grande Adesivo Colorido do Microsoft Copilot no Descanso de Pulso Esquerdo (Exato da Foto!)
    const copilotSticker = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 1.7),
      new THREE.MeshBasicMaterial({ map: createCopilotStickerTexture(), transparent: true })
    );
    copilotSticker.rotation.x = -Math.PI / 2 + 0.08;
    copilotSticker.position.set(-5.6, 0.40, 2.95);
    kbGroup.add(copilotSticker);

    // Botões Redondos de Modo Jogo e Iluminação no Topo Superior Direito
    const roundBtnGeo = new THREE.CylinderGeometry(0.24, 0.26, 0.12, 18);
    const roundBtnMat = new THREE.MeshStandardMaterial({ color: 0x131518, roughness: 0.5 });
    [3.2, 4.0].forEach((bx, idx) => {
      const btn = new THREE.Mesh(roundBtnGeo, roundBtnMat);
      btn.position.set(bx, 0.50, -3.4);
      const dot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.10, 0.13, 12),
        new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x00d2ff : 0xffffff })
      );
      dot.position.set(bx, 0.505, -3.4);
      kbGroup.add(btn, dot);
    });

    // Bloco de Mídia Dedicado do G213: Mute, Barra de Volume (+/-), Stop, Prev, Play/Pause, Next
    const muteBtn = new THREE.Mesh(roundBtnGeo, roundBtnMat);
    muteBtn.position.set(5.1, 0.50, -3.4);
    const volumeRocker = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.14, 0.44),
      new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.4 })
    );
    volumeRocker.position.set(6.3, 0.51, -3.4);
    kbGroup.add(muteBtn, volumeRocker);

    // 4 Botões de Reprodução (Stop, Back, Play, Next)
    [4.6, 5.3, 6.0, 6.7].forEach((bx) => {
      const pbtn = new THREE.Mesh(roundBtnGeo, roundBtnMat);
      pbtn.position.set(bx, 0.50, -2.7);
      kbGroup.add(pbtn);
    });

    // Teclado sem fio: sem cabo, só um LED de conexão 2.4 GHz
    const kbLinkLed = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.14), new THREE.MeshBasicMaterial({ color: 0x7ee787 }));
    kbLinkLed.position.set(6.9, 0.5, -3.4);
    kbGroup.add(kbLinkLed);

    // Teclas com Perfil Completo ABNT2 e Iluminação Ciano Suave (#00b4d8)
    const keyCapMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.35 });
    const keyGlowMat = new THREE.MeshBasicMaterial({ color: 0x00b4d8 });
    // Teclas instanciadas: 2 chamadas de desenho no lugar de ~200 malhas (uma tecla e um brilho por posição)
    const keySlots = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 18; col++) {
        if (row === 0 && (col === 1 || col === 6 || col === 11)) continue;
        if (col === 14 && row > 0 && row < 4) continue;
        if (row === 4 && (col === 14 || col === 15 || col === 17)) continue;
        keySlots.push([-7.0 + col * 0.82, -2.6 + row * 0.72 + (row > 0 ? 0.16 : 0)]);
      }
    }
    const keyCaps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.66, 0.22, 0.58), keyCapMat, keySlots.length);
    const keyGlows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.44, 0.18), keyGlowMat, keySlots.length);
    const _keyM = new THREE.Matrix4(), _keyRot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    keySlots.forEach(([kx, kz], i) => {
      keyCaps.setMatrixAt(i, _keyM.makeTranslation(kx, 0.58, kz));
      keyGlows.setMatrixAt(i, _keyM.makeTranslation(kx, 0.695, kz - 0.08).multiply(_keyRot));
    });
    keyCaps.castShadow = true;
    kbGroup.add(keyCaps, keyGlows);
    kbGroup.position.set(4.5, 0.14, 4.5);
    deskWorld.add(kbGroup);

    // 6. MOUSE GAMER LOGITECH G502 (Sem Fio, Scroll Metálico e LEDs DPI!)
    const mouseGroup = new THREE.Group();
    const g502BodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.35, metalness: 0.15 });
    const g502GripMat = new THREE.MeshStandardMaterial({ color: 0x121417, roughness: 0.8 });
    const g502GlossMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.06, metalness: 0.4 });
    const g502CyanMat = new THREE.MeshBasicMaterial({ color: 0x00d8ff });

    // Mouse sem fio: sem cabo

    // Aba Lateral Esquerda Ergonômica para o Polegar (Thumb Wing)
    const wingShape = new THREE.Shape();
    wingShape.moveTo(-1.0, -1.2);
    wingShape.quadraticCurveTo(-1.85, -0.3, -1.92, 0.55);
    wingShape.quadraticCurveTo(-1.75, 1.35, -0.95, 1.65);
    wingShape.lineTo(-0.5, 1.4);
    wingShape.lineTo(-0.5, -1.1);
    wingShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.08, bevelSegments: 6 });
    wingGeo.rotateX(Math.PI / 2);
    const wingMesh = new THREE.Mesh(wingGeo, g502GripMat);
    wingMesh.position.set(0, 0.24, 0.2);
    wingMesh.castShadow = true;
    mouseGroup.add(wingMesh);

    // Dorso Anatômico Esculpido do G502
    const palmDomed = new THREE.Mesh(new THREE.SphereGeometry(1.18, 28, 20), g502BodyMat);
    palmDomed.scale.set(0.95, 0.68, 1.45);
    palmDomed.position.set(0.05, 0.42, 0.55);
    palmDomed.castShadow = true;
    mouseGroup.add(palmDomed);

    // Botões LMB e RMB Angulados
    const lmbMesh = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.26, 1.95), g502BodyMat);
    lmbMesh.position.set(-0.52, 0.72, -0.95);
    lmbMesh.rotation.x = 0.24; lmbMesh.rotation.y = 0.04; lmbMesh.castShadow = true;
    const rmbMesh = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.26, 2.25), g502BodyMat);
    rmbMesh.position.set(0.56, 0.70, -1.08);
    rmbMesh.rotation.x = 0.25; rmbMesh.rotation.y = -0.05; rmbMesh.castShadow = true;
    mouseGroup.add(lmbMesh, rmbMesh);

    // Botões G8 e G7
    const g8Btn = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.58), g502GlossMat);
    g8Btn.position.set(-0.98, 0.68, -1.42); g8Btn.rotation.x = 0.25;
    const g7Btn = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.58), g502GlossMat);
    g7Btn.position.set(-0.98, 0.76, -0.78); g7Btn.rotation.x = 0.22;
    mouseGroup.add(g8Btn, g7Btn);

    // Os 3 Traços Luminosos Ciano de Indicador de DPI (///)
    for (let i = 0; i < 3; i++) {
      const dpiSlash = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.22), g502CyanMat);
      dpiSlash.position.set(-1.05, 0.74 - i * 0.03, -0.25 + i * 0.26);
      dpiSlash.rotation.y = 0.35;
      mouseGroup.add(dpiSlash);
    }

    // Scroll Wheel Metálico Aberto com Raios Cromados + Faixa de Borracha Central
    const centerSpine = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.35, 2.15), g502GlossMat);
    centerSpine.position.set(0.02, 0.70, -0.85);
    centerSpine.rotation.x = 0.18;
    mouseGroup.add(centerSpine);

    const g502WheelRim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.24, 24),
      new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 0.95, roughness: 0.15 })
    );
    g502WheelRim.rotation.z = Math.PI / 2;
    g502WheelRim.position.set(0.02, 0.82, -1.25);
    const g502WheelTire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 0.12, 24),
      new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.85 })
    );
    g502WheelTire.rotation.z = Math.PI / 2;
    g502WheelTire.position.set(0.02, 0.82, -1.25);
    mouseGroup.add(g502WheelRim, g502WheelTire);

    const freeSpinBtn = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.26), g502BodyMat);
    freeSpinBtn.position.set(0.02, 0.88, -0.62);
    const g9Btn = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.28), g502GlossMat);
    g9Btn.position.set(0.02, 0.92, -0.24);
    mouseGroup.add(freeSpinBtn, g9Btn);

    // Logo "G" Ciano Iluminado
    function createG502LogoTexture() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = '#00e5ff';
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 12;
      ctx.font = '900 92px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('G', 64, 66);
      return new THREE.CanvasTexture(c);
    }
    const g502Logo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.76),
      new THREE.MeshBasicMaterial({ map: createG502LogoTexture(), transparent: true, depthTest: true })
    );
    g502Logo.rotation.x = -Math.PI / 2 + 0.18;
    g502Logo.position.set(-0.26, 1.21, 0.72);
    mouseGroup.add(g502Logo);

    // Lista de objetos que o carrinho pode segurar e arrastar pela mesa!
    // grabbableItems already declared

    mouseGroup.position.set(15.6, 0.14, 4.6);
    mouseGroup.rotation.y = -0.12;
    deskWorld.add(mouseGroup);
    const mouseObs = registerDynamicObstacle({
      obs: { x: 15.6, z: 4.6, r: 1.85, name: 'MOUSE LOGITECH G502 (SEM FIO)' },
      group: mouseGroup,
      mass: 0.65,
      canTopple: false
    });
    registerGrabbable({
      id: 'mouse', name: 'Mouse Logitech G502 HERO', group: mouseGroup, obs: mouseObs,
      initX: 15.6, initY: 0.14, initZ: 4.6, initRotY: -0.12, grabRadius: 5.0
    });

    // 7. CANECA PRETA MULESOFT MENTOR COM BASE DE CORTIÇA E PORTA-COPOS DE COURO COSTURADO
    const mugGroup = new THREE.Group();
    // Porta-copos (Coaster) em Couro Marrom com Costura Clara Perimetral
    const coaster = new THREE.Mesh(
      new THREE.CylinderGeometry(2.35, 2.35, 0.16, 32),
      new THREE.MeshStandardMaterial({ map: createLeatherCoasterTexture(), roughness: 0.7 })
    );
    coaster.position.y = 0.08; coaster.receiveShadow = true; mugGroup.add(coaster);

    // Base Inferior de Cortiça da Própria Caneca
    const corkBase = new THREE.Mesh(
      new THREE.CylinderGeometry(1.72, 1.66, 0.95, 32),
      new THREE.MeshStandardMaterial({ map: createCorkTexture(), roughness: 0.92 })
    );
    corkBase.position.y = 0.63; corkBase.castShadow = true; mugGroup.add(corkBase);

    // Corpo Preto Fosco da Caneca
    const mugBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.76, 1.72, 2.95, 32),
      new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.55 })
    );
    mugBody.position.y = 2.58; mugBody.castShadow = true; mugGroup.add(mugBody);

    // Borda Superior de Aço Inox Escovado
    // Borda aberta (tubo + anel no topo): antes era um cilindro fechado que tampava o café
    const mugRim = new THREE.Mesh(new THREE.CylinderGeometry(1.78, 1.75, 0.28, 32, 1, true), inoxMat.clone());
    mugRim.material.side = THREE.DoubleSide;
    mugRim.position.y = 4.19;
    const mugRimTop = new THREE.Mesh(new THREE.RingGeometry(1.66, 1.79, 40), inoxMat);
    mugRimTop.rotation.x = -Math.PI / 2;
    mugRimTop.position.y = 4.335;
    mugGroup.add(mugRimTop);
    // Café Escuro Quente Dentro
    // Café quente: superfície com creme (crema) girando devagar e reflexo; o vapor sai por cima (ver updateCoffeeSteam)
    const coffeeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: liquidUniforms.uTime },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p), a = atan(p.y, p.x);
          float swirl = sin(a * 3.0 + r * 9.0 - uTime * 0.7) * 0.5 + 0.5;
          float swirl2 = sin(a * 5.0 - r * 13.0 + uTime * 0.45) * 0.5 + 0.5;
          vec3 coffee = vec3(0.16, 0.075, 0.03);
          vec3 crema = vec3(0.62, 0.38, 0.19);
          float mask = smoothstep(0.55, 0.97, r) * 0.85 + (swirl * 0.22 + swirl2 * 0.12) * smoothstep(0.15, 0.85, r);
          vec3 col = mix(coffee, crema, clamp(mask, 0.0, 1.0));
          float spec = pow(max(0.0, 1.0 - length(p - vec2(-0.32, 0.36)) * 2.6), 6.0);
          col += spec * 0.45;
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const coffeeInside = new THREE.Mesh(new THREE.CircleGeometry(1.7, 40), coffeeMat);
    coffeeInside.rotation.x = -Math.PI / 2;
    coffeeInside.position.y = 4.22;
    coffeeInside.userData.isCoffee = true;

    // Alça Retangular Metálica Moderna com Cantos Suaves (Exata da Foto do Usuário!)
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.45, metalness: 0.4 });
    const handleTop = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.22), handleMat);
    handleTop.position.set(2.32, 3.45, 0);
    const handleSide = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.95, 0.22), handleMat);
    handleSide.position.set(2.86, 2.50, 0);
    const handleBottom = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.22), handleMat);
    handleBottom.position.set(2.32, 1.55, 0);
    mugGroup.add(mugRim, coffeeInside, handleTop, handleSide, handleBottom);

    // Emblema Oficial em Alta Fidelidade "MULESOFT MENTOR" no corpo da caneca
    const emblem = new THREE.Mesh(
      new THREE.PlaneGeometry(2.35, 2.35),
      new THREE.MeshBasicMaterial({ map: createMulesoftMentorTexture(), transparent: true })
    );
    emblem.position.set(0, 2.62, 1.77);
    mugGroup.add(emblem);

    mugGroup.position.set(21.5, 0.14, -2.5);
    deskWorld.add(mugGroup);

    // ---------- Vapor do café quente (sai de todas as canecas MuleSoft) ----------
    const coffeeMugs = [mugGroup]; // a caneca gigante do Portal 4 entra aqui também
    const steamTexture = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.45, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const steamPuffs = [];
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: steamTexture, transparent: true, opacity: 0, depthWrite: false, color: 0xf4f1ee }));
      s.visible = false;
      scene.add(s);
      steamPuffs.push({ s, life: 0, max: 1, vx: 0, vz: 0, k: 1, phase: 0 });
    }
    const _coffeeWorld = new THREE.Vector3(), _coffeeUp = new THREE.Vector3();
    let steamSpawnAcc = 0;
    function updateCoffeeSteam(dt, time) {
      steamSpawnAcc += dt * 9; // ~9 baforadas por segundo por caneca
      while (steamSpawnAcc >= 1) {
        steamSpawnAcc -= 1;
        coffeeMugs.forEach((mug) => {
          if (!mug.visible) return;
          let coffee = mug.userData.coffeeMesh;
          if (!coffee) { mug.traverse((o) => { if (o.userData && o.userData.isCoffee) coffee = o; }); mug.userData.coffeeMesh = coffee; }
          if (!coffee) return;
          // Caneca tombada não solta vapor
          _coffeeUp.set(0, 1, 0).applyQuaternion(mug.getWorldQuaternion(new THREE.Quaternion()));
          if (_coffeeUp.y < 0.85) return;
          coffee.getWorldPosition(_coffeeWorld);
          const k = mug.getWorldScale(new THREE.Vector3()).x; // caneca gigante = vapor maior
          const p = steamPuffs.find(q => q.life <= 0);
          if (!p) return;
          p.life = p.max = 1.6 + Math.random() * 0.9;
          p.k = k;
          p.vx = (Math.random() - 0.5) * 0.25 * k; p.vz = (Math.random() - 0.5) * 0.25 * k;
          p.phase = Math.random() * 6.28;
          p.s.position.set(_coffeeWorld.x + (Math.random() - 0.5) * 1.6 * k, _coffeeWorld.y + 0.15 * k, _coffeeWorld.z + (Math.random() - 0.5) * 1.6 * k);
          p.s.visible = true;
        });
      }
      steamPuffs.forEach((p) => {
        if (p.life <= 0) return;
        p.life -= dt;
        if (p.life <= 0) { p.s.visible = false; return; }
        const age = 1 - p.life / p.max; // 0 → 1
        p.s.position.x += (p.vx + Math.sin(time * 2.2 + p.phase) * 0.35 * p.k) * dt;
        p.s.position.z += (p.vz + Math.cos(time * 1.7 + p.phase) * 0.25 * p.k) * dt;
        p.s.position.y += (1.4 + age * 0.8) * p.k * dt;
        const size = (0.6 + age * 1.8) * p.k;
        p.s.scale.set(size, size, 1);
        p.s.material.opacity = Math.sin(age * Math.PI) * 0.38;
      });
    }
    const mugObs = registerDynamicObstacle({
      obs: { x: 21.5, z: -2.5, r: 1.95, name: 'CANECA MULESOFT MENTOR COM CORTIÇA' },
      group: mugGroup,
      mass: 1.6,
      canTopple: true
    });
    registerGrabbable({
      id: 'mug', name: 'Caneca MuleSoft Mentor', group: mugGroup, obs: mugObs,
      initX: 21.5, initY: 0.14, initZ: -2.5, initRotY: 0, grabRadius: 5.2
    });

    // Registra também os controles Xbox e PS5 como seguráveis/arrastáveis
    breakableControllers.forEach((c, idx) => {
      registerGrabbable({
        id: 'ctrl_' + idx, name: c.name, group: c.group, obs: c.obs,
        initX: c.initX, initY: 0.14, initZ: c.initZ, initRotY: c.initRotY, grabRadius: 5.0
      });
    });

    // ============================================================================
    // CIRCUITO DO RAVI — PISTA TÉCNICA ORIGINAL (chicanes, grampos e "S" em sequência)
    // Mesa → rampa de papelão → circuito embaixo da mesa → rampa de retorno → mesa
    // ============================================================================
    const TRACK_WIDTH = 9.2;
    // [x, z, nível]  d = mesa · r = rampa · f = chão do quarto (sentido da volta)
    const TRACK_POINTS = [
      [-79, 0, 'd'], [-77, 12, 'd'], [-83, 18, 'd'], [-88, 18, 'd'],
      [-91, 18, 'r'], [-134, 18, 'r'],
      [-142, 17, 'f'], [-152, 8, 'f'], [-155, -8, 'f'], [-150, -24, 'f'], [-136, -34, 'f'],
      [-110, -38, 'f'], [-70, -38, 'f'], [-30, -35, 'f'], [10, -40, 'f'], [40, -36, 'f'],
      [54, -26, 'f'], [54, -10, 'f'], [53, 8, 'f'], [48, 22, 'f'], [36, 30, 'f'],
      [18, 25, 'f'], [0, 33, 'f'], [-18, 25, 'f'], [-36, 33, 'f'], [-54, 27, 'f'], [-72, 36, 'f'],
      [-90, 52, 'f'], [-112, 58, 'f'], [-140, 60, 'f'], [-156, 54, 'f'], [-158, 44, 'f'], [-150, 38, 'f'],
      [-142, 38, 'f'], [-135, 38, 'r'], [-91, 38, 'r'],
      [-86, 38, 'd'], [-72, 44, 'd'], [-50, 46, 'd'], [-30, 43, 'd'], [-10, 46, 'd'], [10, 43, 'd'],
      [30, 46, 'd'], [50, 45, 'd'], [61, 38, 'd'], [66, 22, 'd'], [66, 0, 'd'], [66, -20, 'd'],
      [62, -36, 'd'], [48, -44, 'd'], [20, -42, 'd'], [-10, -46, 'd'], [-40, -42, 'd'], [-62, -44, 'd'],
      [-76, -34, 'd'], [-80, -16, 'd']
    ];
    const trackCurve = new THREE.CatmullRomCurve3(TRACK_POINTS.map(p => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');

    function trackLevelForSegment(i) {
      const n = TRACK_POINTS.length;
      const a = TRACK_POINTS[i % n][2], b = TRACK_POINTS[(i + 1) % n][2];
      if (a === 'r' && b === 'r') return 'ramp';
      if (a === 'd' || b === 'd') return 'desk';
      return 'floor';
    }
    // Altura da superfície da pista (acompanha mesa, rampa e chão, sempre um fio acima)
    // Topo exato da caixa da rampa de papelão: centro (-112.5, -17.925), espessura 0.35, inclinação 0.6728 rad
    const RAMP_TOP_SLOPE = Math.tan(Math.atan2(35.85, 45));
    const RAMP_TOP_X0 = -112.5 - 0.175 * Math.sin(Math.atan2(35.85, 45));
    const RAMP_TOP_Y0 = -17.925 + 0.175 * Math.cos(Math.atan2(35.85, 45));
    function trackSurfaceY(x, level, z = 0) {
      if (level === 'desk') {
        // Já passou da borda da mesa: segue o topo da rampa
        if (x < -90) return THREE.MathUtils.clamp(RAMP_TOP_Y0 + (x - RAMP_TOP_X0) * RAMP_TOP_SLOPE + 0.04, -35.78, 0.29);
        // Em cima da aba de papelão (x -90..-80) a pista sobe para não ficar escondida embaixo dela
        const onLip = x < -79.6 && ((z > 9.8 && z < 26.2) || (z > 29.8 && z < 46.2));
        return onLip ? 0.27 : 0.165;
      }
      if (level === 'floor') return -35.815;
      const top = RAMP_TOP_Y0 + (x - RAMP_TOP_X0) * RAMP_TOP_SLOPE;
      return THREE.MathUtils.clamp(top + 0.04, -35.78, 0.29);
    }

    // Amostras ao longo da pista (posição, nível e distância acumulada)
    const trackSamples = [];
    let trackLength = 0;
    (function sampleTrack() {
      const n = TRACK_POINTS.length;
      for (let i = 0; i < n; i++) {
        const a = TRACK_POINTS[i], b = TRACK_POINTS[(i + 1) % n];
        const level = trackLevelForSegment(i);
        const steps = Math.max(4, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.7));
        for (let s = 0; s < steps; s++) {
          const p = trackCurve.getPoint((i + s / steps) / n);
          trackSamples.push({ x: p.x, z: p.z, y: trackSurfaceY(p.x, level, p.z), level: level === 'ramp' ? 'ramp' : level, seg: i, dist: 0 });
        }
      }
      for (let k = 1; k < trackSamples.length; k++) {
        const p = trackSamples[k - 1], q = trackSamples[k];
        q.dist = p.dist + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      }
      const last = trackSamples[trackSamples.length - 1], first = trackSamples[0];
      trackLength = last.dist + Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);
    })();

    function trackFrameAt(k) {
      const N = trackSamples.length;
      const s = trackSamples[((k % N) + N) % N];
      const prev = trackSamples[((k - 1) % N + N) % N], next = trackSamples[(k + 1) % N];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      return { s, tx, tz, nx: -tz, nz: tx };
    }
    function nearestTrackSample(x, z, level) {
      let best = 0, bestD = Infinity;
      trackSamples.forEach((s, k) => {
        if (level && s.level !== level) return;
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      });
      return best;
    }

    // Textura do asfalto: zebras vermelhas/brancas, linhas de borda e faixa central tracejada
    function createTrackTexture() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3d424b';
      ctx.fillRect(0, 0, 128, 256);
      for (let i = 0; i < 900; i++) {
        const g = 50 + Math.random() * 40;
        ctx.fillStyle = `rgba(${g},${g + 4},${g + 10},0.55)`;
        ctx.fillRect(Math.random() * 128, Math.random() * 256, 1.5, 1.5);
      }
      [[0, 14], [114, 14]].forEach(([x, w]) => {
        ctx.fillStyle = '#e53935'; ctx.fillRect(x, 0, w, 128);
        ctx.fillStyle = '#f4f4ef'; ctx.fillRect(x, 128, w, 128);
      });
      ctx.fillStyle = '#f4f4ef';
      ctx.fillRect(16, 0, 3, 256);
      ctx.fillRect(109, 0, 3, 256);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(62, 0, 4, 120);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return tex;
    }

    // Pista como um tapete: topo um pouco acima da superfície e borda lateral emborrachada (igual ao mousepad da mesa).
    // A pista principal fica mais alta que o atalho escondido: onde os dois se cruzam não há mais disputa de profundidade.
    const TRACK_RAISE = 0.07, TRACK_SKIRT = 0.16;
    const trackSkirtMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.9 });
    // positions: pares (borda esquerda, borda direita) por amostra, já com a altura do topo
    function createTrackSkirt(positions, segs) {
      const pos = [], idx = [];
      const count = positions.length / 6;
      for (let side = 0; side < 2; side++) {
        const base = pos.length / 3;
        for (let k = 0; k < count; k++) {
          const o = k * 6 + side * 3;
          const x = positions[o], y = positions[o + 1], z = positions[o + 2];
          pos.push(x, y, z, x, y - TRACK_SKIRT, z);
        }
        for (let k = 0; k < Math.min(segs, count - 1); k++) {
          const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
          if (side === 0) idx.push(a, b, c, c, b, d); else idx.push(a, c, b, c, d, b);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, trackSkirtMat);
      m.material.side = THREE.DoubleSide;
      m.receiveShadow = true;
      return m;
    }
    const trackPaintUniforms = { uMagic: { value: 0 }, uTrackTime: { value: 0 } };
    const trackMesh = (() => {
      const N = trackSamples.length;
      const positions = new Float32Array((N + 1) * 2 * 3);
      const uvs = new Float32Array((N + 1) * 2 * 2);
      const indices = [];
      const half = TRACK_WIDTH / 2;
      for (let k = 0; k <= N; k++) {
        const f = trackFrameAt(k % N);
        const v = (k === N ? trackLength : f.s.dist) / 8;
        const ty = f.s.y + TRACK_RAISE;
        positions.set([f.s.x + f.nx * half, ty, f.s.z + f.nz * half, f.s.x - f.nx * half, ty, f.s.z - f.nz * half], k * 6);
        uvs.set([0, v, 1, v], k * 4);
        if (k < N) {
          const a = k * 2, b = k * 2 + 1, c = k * 2 + 2, d = k * 2 + 3;
          indices.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        map: createTrackTexture(), roughness: 0.82, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide
      });
      // Pintura com o lápis de cor: cada vértice guarda se foi pintado (aPaint) e a cor do giz (aHue)
      geo.setAttribute('aPaint', new THREE.BufferAttribute(new Float32Array((N + 1) * 2), 1));
      geo.setAttribute('aHue', new THREE.BufferAttribute(new Float32Array((N + 1) * 2), 1));
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, trackPaintUniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
            attribute float aPaint; attribute float aHue;
            varying float vPaint; varying float vHue; varying vec2 vTrackUv;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vPaint = aPaint; vHue = aHue; vTrackUv = uv;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform float uMagic; uniform float uTrackTime;
            varying float vPaint; varying float vHue; varying vec2 vTrackUv;
            vec3 hsv2rgbT(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
            vec3 trackGlow = vec3(0.0);`)
          .replace('#include <map_fragment>', `#include <map_fragment>
            // Riscos de giz de cera: listras levemente irregulares ao longo da pista
            if (vPaint > 0.01) {
              float wax = 0.72 + 0.28 * sin(vTrackUv.x * 46.0 + sin(vTrackUv.y * 9.0) * 2.0);
              vec3 crayon = hsv2rgbT(vec3(vHue, 0.8, 0.85)) * wax;
              diffuseColor.rgb = mix(diffuseColor.rgb, crayon, clamp(vPaint, 0.0, 1.0) * 0.42);
            }
            // Pista mágica (conquista secreta): brilho de arco-íris suave correndo pela pista
            if (uMagic > 0.5) {
              float h = fract(vTrackUv.y * 0.11 + vTrackUv.x * 0.18 - uTrackTime * 0.06);
              vec3 rainbow = hsv2rgbT(vec3(h, 0.75, 0.8));
              float pulse = 0.2 + 0.06 * sin(uTrackTime * 2.2 + vTrackUv.y * 2.5);
              diffuseColor.rgb = mix(diffuseColor.rgb, rainbow, pulse);
              trackGlow = rainbow * 0.05;
              // Zebras (bordas) acendem em arco-íris
              float edge = smoothstep(0.86, 0.97, abs(vTrackUv.x - 0.5) * 2.0);
              trackGlow += hsv2rgbT(vec3(fract(h + 0.5), 0.6, 1.0)) * edge * (0.22 + 0.12 * sin(uTrackTime * 4.0 + vTrackUv.y * 6.0));
              // Faixa de reflexo mágico que percorre a pista
              float sweep = smoothstep(0.0, 0.08, 0.08 - abs(fract(vTrackUv.y * 0.05 - uTrackTime * 0.12) - 0.5));
              trackGlow += vec3(1.0, 0.95, 1.0) * sweep * 0.25;
              // Brilhinhos cintilantes espalhados (estrelinhas)
              vec2 cell = floor(vTrackUv * vec2(9.0, 3.5));
              float rnd = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
              vec2 inCell = fract(vTrackUv * vec2(9.0, 3.5)) - 0.5;
              float twinkle = max(0.0, sin(uTrackTime * 3.0 + rnd * 60.0));
              float star = step(0.82, rnd) * (1.0 - smoothstep(0.0, 0.09, length(inCell))) * twinkle;
              trackGlow += vec3(1.0) * star * 0.9;
            }`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            totalEmissiveRadiance += trackGlow;`);
      };
      mat.customProgramCacheKey = () => 'track-paint-v2';
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.name = 'Circuito do Ravi';
      scene.add(mesh);
      // Borda lateral do "tapete": desce do topo até abaixo da superfície (some dentro da mesa/chão)
      scene.add(createTrackSkirt(positions, N));
      return mesh;
    })();

    // Atalho escondido embaixo da mesa: sai da reta de trás, sobe a rampa do apoio de pés,
    // salta e reencontra a pista no "S". Mesma textura, pista um pouco mais estreita.
    function buildTrackRibbon(points, width) {
      const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
      const N = Math.max(8, Math.ceil(curve.getLength() / 0.6));
      const pts = curve.getSpacedPoints(N);
      const positions = [], uvs = [], idx = [];
      let dist = 0;
      for (let k = 0; k <= N; k++) {
        const p = pts[k], a = pts[Math.max(0, k - 1)], b = pts[Math.min(N, k + 1)];
        let tx = b.x - a.x, tz = b.z - a.z;
        const len = Math.hypot(tx, tz) || 1; tx /= len; tz /= len;
        const nx = -tz, nz = tx, half = width / 2;
        if (k > 0) dist += p.distanceTo(pts[k - 1]);
        const ry = p.y + TRACK_RAISE * 0.45; // abaixo da pista principal: no cruzamento, a principal fica por cima
        positions.push(p.x + nx * half, ry, p.z + nz * half, p.x - nx * half, ry, p.z - nz * half);
        uvs.push(0, dist / 8, 1, dist / 8);
        if (k < N) { const i0 = k * 2; idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      // Mesmo material da pista principal: atributos de pintura zerados (atalho não entra na conta)
      geo.setAttribute('aPaint', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3), 1));
      geo.setAttribute('aHue', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3), 1));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, trackMesh.material);
      mesh.receiveShadow = true;
      mesh.renderOrder = -1;
      scene.add(mesh);
      scene.add(createTrackSkirt(positions, N));
      return mesh;
    }
    (function createHiddenShortcut() {
      const FY = -35.815;
      const rampH = (z) => {
        if (z < -15.2) {
          const t = clamp((z - (-24.0)) / 8.8, 0, 1);
          return FY + t * (footrestTopAt(-15.2) + 0.15) + 0.05;
        } else if (z <= -5.2) {
          return -36 + footrestTopAt(z) + 0.20;
        } else {
          const t = clamp((4.5 - z) / 9.7, 0, 1);
          return FY + t * (footrestTopAt(-5.2) + 0.15) + 0.05;
        }
      };
      // Pista contínua de aproximação, subida, travessia central e descida em direção à frente da mesa
      // Pontos densos sobre a superfície real das 3 placas (antes a curva suavizada afundava dentro da rampa)
      const onRamp = [];
      for (let z = -24.0; z <= 4.5 + 1e-6; z += 0.5) onRamp.push([4, rampH(z) + 0.14, z]);
      const shortcutRibbon = buildTrackRibbon([
        [0, FY, -37.5], [2, FY, -30], [3.6, FY, -26],
        ...onRamp,
        [4.4, FY, 7], [5, FY, 11], [7, FY, 19], [9, FY, 25], [11, FY, 28.5]
      ], 7);
      shortcutRibbon.renderOrder = 2;
    })();

    // Faixa quadriculada de largada
    const START_SAMPLE = nearestTrackSample(-10, 46, 'desk');
    (function createStartLine() {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 32;
      const ctx = c.getContext('2d');
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#111111' : '#ffffff';
        ctx.fillRect(i * 16, j * 16, 16, 16);
      }
      const f = trackFrameAt(START_SAMPLE);
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(TRACK_WIDTH * 0.78, 1.6),
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.rotation.z = Math.atan2(f.tx, f.tz) + Math.PI / 2;
      plane.position.set(f.s.x, f.s.y + TRACK_RAISE + 0.012, f.s.z);
      plane.receiveShadow = true;
      scene.add(plane);
    })();

    // Textos 3D com a fonte de mundo do DS (Pally) em superfície ameixa
    function drawDsLabel(canvas, text, opts = {}) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createRadialGradient(w, 0, 0, w, 0, w * 1.1);
      if (opts.trigger) { grad.addColorStop(0, '#c21515'); grad.addColorStop(1, '#46123b'); }
      else { grad.addColorStop(0, '#251f2b'); grad.addColorStop(1, '#1d1721'); }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 3;
      ctx.strokeRect(9, 9, w - 18, h - 18);
      ctx.fillStyle = opts.color || '#ffffff';
      ctx.font = `500 ${Math.round(h * 0.5)}px Pally-Medium, Nunito, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + h * 0.03);
    }
    const dsLabelRedraws = [];
    function createDsLabelTexture(text, opts) {
      const c = document.createElement('canvas');
      c.width = opts && opts.width || 512; c.height = opts && opts.height || 128;
      drawDsLabel(c, text, opts);
      const tex = new THREE.CanvasTexture(c);
      dsLabelRedraws.push(() => { drawDsLabel(c, text, opts); tex.needsUpdate = true; });
      return tex;
    }
    if (document.fonts && document.fonts.load) {
      document.fonts.load('500 64px Pally-Medium').then(() => dsLabelRedraws.forEach(fn => fn())).catch(() => {});
    }

    // Portais de checkpoint (pilares luminosos + faixa com o número)
    const raceGates = [];
    const gatePostGeo = new THREE.CylinderGeometry(0.32, 0.4, 8.5, 12);
    function createRaceGate(x, z, level, label, isStart) {
      const k = nearestTrackSample(x, z, level);
      const f = trackFrameAt(k);
      const group = new THREE.Group();
      group.position.set(f.s.x, f.s.y, f.s.z);
      group.rotation.y = Math.atan2(f.tx, f.tz);
      const postMat = new THREE.MeshStandardMaterial({ color: 0xffceca, emissive: 0xffceca, emissiveIntensity: 0.15, roughness: 0.4 });
      [-1, 1].forEach((side) => {
        const post = new THREE.Mesh(gatePostGeo, postMat);
        post.position.set(side * (TRACK_WIDTH / 2 + 0.7), 4.25, 0);
        post.castShadow = true;
        group.add(post);
      });
      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(TRACK_WIDTH + 2.2, 1.9),
        new THREE.MeshBasicMaterial({ map: createDsLabelTexture(label, { trigger: true, width: 512, height: 110 }), side: THREE.DoubleSide })
      );
      banner.position.y = 8.2;
      group.add(banner);
      scene.add(group);
      const gate = { k, x: f.s.x, y: f.s.y, z: f.s.z, level: f.s.level, group, postMat, isStart };
      raceGates.push(gate);
      return gate;
    }
    createRaceGate(-10, 46, 'desk', 'LARGADA', true);
    createRaceGate(66, 0, 'desk', 'PORTAL 1');
    createRaceGate(-40, -42, 'desk', 'PORTAL 2');
    createRaceGate(-155, -8, 'floor', 'PORTAL 3');
    createRaceGate(-40, -35, 'floor', 'PORTAL 4'); // antes do atalho do apoio de pés
    createRaceGate(0, 33, 'floor', 'PORTAL 5');
    createRaceGate(-140, 60, 'floor', 'PORTAL 6');

    // ============================================================================
    // MARCOS DE CARREIRA — cada portal tem um objeto especial e uma "ilha" de evento
    // (dados do currículo do Jeferson; objetos fixos, um pouco maiores que o carrinho)
    // ============================================================================
    const CAREER_MILESTONES = [
      {
        portal: 1, title: 'Magnum Bank', company: 'Sciensa', role: 'Desenvolvedor MuleSoft e Java',
        period: 'abr. 2022 – mai. 2023 · 1 ano 2 meses', place: 'São Paulo, SP · Tempo integral',
        emoji: '🐷', color: '#8338ec', label: 'Sciensa',
        intro: 'A virada: transição de carreira para desenvolvedor MuleSoft, começando num banco digital.',
        bullets: [
          'Projeto MAGNUM BANK (Fintech / Banco Digital): APIs de microsserviços de alta velocidade com Java (Spring Boot, Quarkus) e Apache Kafka para streaming de transações financeiras em tempo real.',
          'Qualidade & cobertura de código: pipeline CI/CD com TDD/BDD, SonarQube e Jenkins, mantendo cobertura de testes automatizados acima de 85%.'
        ],
        tags: ['MuleSoft', 'Java', 'Spring Boot', 'Quarkus', 'Kafka', 'RAML', 'CI/CD']
      },
      {
        portal: 2, title: 'Projeto ENEL', company: 'Capgemini', role: 'Desenvolvedor MuleSoft Pleno',
        period: 'mai. 2023 – ago. 2024 · 1 ano 4 meses', place: 'São Paulo · Remoto',
        emoji: '🔋', color: '#2a9d8f', label: 'Capgemini',
        intro: 'Energia em escala: migração de centenas de APIs de uma gigante do setor elétrico.',
        bullets: [
          'Projeto ENEL (Energia & Utilities): atuação chave na migração de 500+ APIs corporativas (1.600+ endpoints) de Node.js para MuleSoft Mule 4, com 45% de ganho de performance via DataWeave e contratos RAML (Contract-First).',
          'Ecossistema Salesforce: conectores customizados integrando MuleSoft ao Salesforce CRM (OmniStudio, Data Cloud, Commerce) e legados via Apex e Flow.',
          'KINTO MOTORS & VW (Automotivo): Flex Gateway na modernização de legados, dashboards no Anypoint Monitoring e rotas críticas via VPC/VPN (GDPR/LGPD).'
        ],
        tags: ['Mule 4', 'DataWeave', 'RAML', 'Salesforce', 'Flex Gateway', 'Anypoint Monitoring']
      },
      {
        portal: 3, title: 'Alta Concorrência', company: 'Prosegur', role: 'Desenvolvedor MuleSoft Senior',
        period: 'set. 2024 – jun. 2025 · 10 meses', place: 'Brasil · Remoto',
        emoji: '🚚', color: '#ffbe0b', label: 'Prosegur',
        intro: 'Segurança em primeiro lugar: integrações para operações de transporte de valores.',
        bullets: [
          'Deploy & Runtime Management: gerenciou clusters no CloudHub, configurando políticas de mTLS, SLAs dinâmicos e balanceamento de carga para operações de alta concorrência.'
        ],
        tags: ['CloudHub', 'mTLS', 'SLA dinâmico', 'Load Balancing', 'Anypoint Platform']
      },
      {
        portal: 4, title: 'MuleSoft Mentor', company: 'Academule', role: 'Co-founder · Consultoria MuleSoft · MuleSoft Mentor',
        period: 'out. 2022 – out. 2026 · 4 anos 1 mês', place: 'São Paulo, SP',
        emoji: '☕', color: '#00a0df', label: 'Academule',
        intro: 'Ensinar e compartilhar: cofundador de uma consultoria e mentor da comunidade MuleSoft.',
        bullets: [
          'Arquitetura reutilizável: bibliotecas DataWeave, políticas de segurança customizadas (mTLS, OAuth2) e archetypes de projetos, reduzindo em 30% a duplicidade de código nos clientes.',
          'Reconhecimento MuleSoft Mentor 2024 (Salesforce/MuleSoft).'
        ],
        tags: ['MuleSoft Mentor', 'DataWeave', 'OAuth2', 'mTLS', 'Archetypes']
      },
      {
        portal: 5, title: 'Projeto AEGEA', company: 'Accenture', role: 'TechLead | Desenvolvedor Senior MuleSoft',
        period: 'jun. 2025 – nov. 2026 · 1 ano 6 meses', place: 'São Paulo, SP · Remoto',
        emoji: '🚰', color: '#3a86ff', label: 'Accenture',
        intro: 'Liderança técnica num projeto de saneamento: água chegando com integrações bem governadas.',
        bullets: [
          'Projeto AEGEA (Saneamento): liderança técnica da equipe de integração.',
          'Liderança técnica & arquitetura: liderou o desenho e a implantação de arquiteturas Mule 4.',
          'Governança de APIs: padrões corporativos API-Led e boas práticas de integração, com 100% de conformidade regulatória e segurança nas entregas.'
        ],
        tags: ['TechLead', 'Mule 4', 'API-Led', 'Governança', 'Arquitetura']
      },
      {
        portal: 6, title: 'Próxima porta', company: 'OrangeDoor', role: 'Desenvolvedor Senior MuleSoft',
        period: 'Em breve', place: 'Novidades em breve',
        emoji: '🚪', color: '#fb8500', label: 'OrangeDoor',
        intro: 'Uma nova porta laranja está se abrindo...',
        bullets: ['Novidades em breve! Volte aqui para descobrir o próximo capítulo.'],
        tags: ['Em breve']
      }
    ];
    // Posições livres ao lado da pista (calculadas pelos portais): objeto e ponto de evento
    const CAREER_SPOTS = [
      { obj: [55, 0], pin: [59.6, 0], level: 'desk', rotY: Math.PI / 2 },
      { obj: [-39.8, -31], pin: [-39.9, -35.6], level: 'desk', rotY: Math.PI },
      { obj: [-144, -7.4], pin: [-148.6, -7.7], level: 'floor', rotY: -Math.PI / 2 },
      { obj: [-40.4, -24.3], pin: [-40.1, -28.9], level: 'floor', rotY: Math.PI },
      { obj: [-6, 20], pin: [-4.5, 25.4], level: 'floor', rotY: 0 }, // fora da pista do atalho (antes invadia a saída dele)
      { obj: [-138.4, 49.1], pin: [-139, 53.7], level: 'floor', rotY: 0 }
    ];
    const careerInteractives = [];
    // Pequenas animações dos objetos dos marcos (moeda do cofrinho, giroflex do carro-forte, porta balançando)
    function updateCareerObjects(time) {
      careerInteractives.forEach((it) => {
        const u = it.object.userData;
        if (u.spin) { u.spin.rotation.z = time * 2; u.spin.position.y = 7.9 + Math.sin(time * 2.4) * 0.25; }
        if (u.beacon) u.beacon.material.emissiveIntensity = (Math.floor(time * 3) % 2) ? 1.6 : 0.2;
        if (u.doorPivot) u.doorPivot.rotation.y = -0.5 + Math.sin(time * 0.9) * 0.08;
        if (u.water) u.water.position.y = 2.6 + Math.sin(time * 1.7) * 0.06;
      });
    }
    (function buildCareerObjects() {
      const mat = (color, opts = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.45, flatShading: false }, opts));
      const surfaceY = (lvl) => (lvl === 'desk' ? 0.14 : FLOOR_SURFACE_Y);

      // 1) Cofrinho roxo (banco digital)
      function piggyBank() {
        const g = new THREE.Group();
        const purple = mat(0x8338ec, { roughness: 0.3 });
        const body = new THREE.Mesh(new THREE.SphereGeometry(3.2, 32, 24), purple);
        body.scale.set(1.25, 1, 1);
        body.position.y = 4.1;
        body.castShadow = true;
        g.add(body);
        const snout = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 1.1, 24), mat(0x9d5cff, { roughness: 0.3 }));
        snout.rotation.z = Math.PI / 2; snout.position.set(4.25, 4.2, 0);
        g.add(snout);
        [-0.4, 0.4].forEach((z) => {
          const nostril = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), new THREE.MeshBasicMaterial({ color: 0x3a0a7a }));
          nostril.rotation.y = Math.PI / 2; nostril.position.set(4.81, 4.2, z);
          g.add(nostril);
        });
        [-1, 1].forEach((s) => {
          const ear = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.4, 4), purple);
          ear.position.set(2.2, 7.0, s * 1.3); ear.rotation.z = -0.4;
          g.add(ear);
          const eye = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), new THREE.MeshBasicMaterial({ color: 0x1a0a2a }));
          eye.position.set(3.55, 5.3, s * 1.2);
          g.add(eye);
        });
        [[-2, -1.6], [-2, 1.6], [2, -1.6], [2, 1.6]].forEach(([x, z]) => {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 1.6, 16), purple);
          leg.position.set(x, 0.8, z);
          g.add(leg);
        });
        const slot = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 0.35), new THREE.MeshBasicMaterial({ color: 0x2a0a55 }));
        slot.position.set(-0.3, 7.15, 0);
        g.add(slot);
        const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.22, 24), mat(0xffc93c, { metalness: 0.8, roughness: 0.25 }));
        coin.rotation.x = Math.PI / 2; coin.position.set(-0.3, 7.9, 0);
        g.add(coin);
        const tail = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.14, 8, 16, Math.PI * 1.5), purple);
        tail.position.set(-4.1, 4.6, 0); tail.rotation.y = Math.PI / 2;
        g.add(tail);
        g.userData.spin = coin;
        return { g, col: { box: { hx: 4.8, hz: 3.3 } }, h: 8.2 };
      }
      // 2) Pilha gigante em pé (energia)
      function bigBattery() {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 8.6, 32), mat(0x2a9d8f, { roughness: 0.3, metalness: 0.2 }));
        body.position.y = 4.3; body.castShadow = true;
        g.add(body);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.62, 2.8, 32), mat(0x16181c, { roughness: 0.3 }));
        band.position.y = 1.5;
        g.add(band);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.4, 0.6, 32), mat(0xd9822b, { metalness: 0.8, roughness: 0.2 }));
        cap.position.y = 8.9;
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.8, 24), mat(0xdfe6ee, { metalness: 0.9, roughness: 0.15 }));
        tip.position.y = 9.6;
        g.add(cap, tip);
        // Raio na frente e sinal de +
        const c = document.createElement('canvas'); c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffe14d';
        ctx.beginPath(); ctx.moveTo(150, 10); ctx.lineTo(60, 140); ctx.lineTo(125, 140); ctx.lineTo(95, 246); ctx.lineTo(200, 100); ctx.lineTo(135, 100); ctx.closePath(); ctx.fill();
        const bolt = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
        bolt.position.set(0, 5.4, 2.62);
        g.add(bolt);
        const plus = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        plus.position.set(0, 8.0, 2.62);
        const plusV = plus.clone(); plusV.rotation.z = Math.PI / 2;
        g.add(plus, plusV);
        return { g, col: { r: 2.9 }, h: 10 };
      }
      // 3) Carro-forte amarelo (transporte de valores)
      function armoredTruck() {
        const g = new THREE.Group();
        const yellow = mat(0xffcc00, { roughness: 0.35 });
        const dark = mat(0x22252b, { roughness: 0.6 });
        const cargo = new THREE.Mesh(new THREE.BoxGeometry(5.0, 5.0, 6.0), yellow);
        cargo.position.set(0, 3.6, -1.4); cargo.castShadow = true;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.6, 3.0), yellow);
        cab.position.set(0, 2.9, 3.0); cab.castShadow = true;
        const windshield = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.4, 0.1), mat(0x8ecae6, { roughness: 0.1, metalness: 0.3 }));
        windshield.position.set(0, 3.7, 4.52);
        const grille = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.0, 0.1), dark);
        grille.position.set(0, 1.9, 4.52);
        g.add(cargo, cab, windshield, grille);
        [-1, 1].forEach((s) => {
          const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.1), new THREE.MeshBasicMaterial({ color: 0xfff6c2 }));
          lamp.position.set(s * 1.7, 1.9, 4.55);
          g.add(lamp);
          // Janelinha blindada e "$" na lateral
          const port = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 1.6), dark);
          port.position.set(s * 2.52, 4.6, -1.4);
          g.add(port);
          [[-3.3], [-0.2], [2.9]].forEach(() => {});
          [3.2, -3.4].forEach((z) => {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.8, 18), dark);
            wheel.rotation.z = Math.PI / 2; wheel.position.set(s * 2.3, 1.05, z);
            const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.84, 12), mat(0xcfd6de, { metalness: 0.8, roughness: 0.2 }));
            hub.rotation.z = Math.PI / 2; hub.position.copy(wheel.position);
            g.add(wheel, hub);
          });
        });
        const c = document.createElement('canvas'); c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1b1e23'; ctx.beginPath(); ctx.arc(128, 128, 110, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 170px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('$', 128, 138);
        const tex = new THREE.CanvasTexture(c);
        [-1, 1].forEach((s) => {
          const sign = new THREE.Mesh(new THREE.CircleGeometry(1.2, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
          sign.rotation.y = s * Math.PI / 2; sign.position.set(s * 2.52, 2.6, -1.4);
          g.add(sign);
        });
        const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0xff9f1c, emissive: 0xff9f1c, emissiveIntensity: 0.8 }));
        beacon.position.set(0, 4.95, 3.0);
        g.add(beacon);
        g.userData.beacon = beacon;
        return { g, col: { box: { hx: 2.6, hz: 4.6 } }, h: 6.2 };
      }
      // 4) Caneca gigante MuleSoft Mentors (cópia da caneca da mesa)
      function giantMug() {
        const g = mugGroup.clone(true);
        g.position.set(0, 0, 0);
        g.rotation.set(0, 0, 0);
        g.scale.setScalar(2.2);
        const wrap = new THREE.Group();
        wrap.add(g);
        coffeeMugs.push(g); // café quente com vapor também na caneca gigante
        return { g: wrap, col: { r: 4.3 }, h: 9.6 };
      }
      // 5) Galão de água + tubulação (saneamento)
      function waterJug() {
        const g = new THREE.Group();
        const jugMat = new THREE.MeshPhysicalMaterial ? new THREE.MeshPhysicalMaterial({ color: 0x8fd3ff, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.72, clearcoat: 1 }) : mat(0x8fd3ff, { transparent: true, opacity: 0.72 });
        const jug = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 6.2, 32), jugMat);
        jug.position.y = 3.3; jug.castShadow = true;
        const shoulder = new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), jugMat);
        shoulder.position.y = 6.4; shoulder.scale.y = 0.55;
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.0, 20), jugMat);
        neck.position.y = 8.0;
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 20), mat(0x1d4ed8, { roughness: 0.3 }));
        cap.position.y = 8.7;
        const water = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.25, 4.8, 32), new THREE.MeshStandardMaterial({ color: 0x2f9bff, transparent: true, opacity: 0.55, roughness: 0.1 }));
        water.position.y = 2.6;
        [1.6, 4.6].forEach((y) => {
          const rib = new THREE.Mesh(new THREE.TorusGeometry(2.42, 0.1, 8, 40), jugMat);
          rib.rotation.x = Math.PI / 2; rib.position.y = y;
          g.add(rib);
        });
        g.add(water, jug, shoulder, neck, cap);
        // Tubulação de PVC com cotovelo ao lado
        const pvc = mat(0xe9edf2, { roughness: 0.5 });
        const pipeV = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 6.5, 20), pvc);
        pipeV.position.set(4.1, 3.25, 0);
        const elbow = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.7, 14, 20, Math.PI / 2), pvc);
        elbow.position.set(2.9, 6.5, 0); elbow.rotation.z = 0;
        const pipeH = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 3.0, 20), pvc);
        pipeH.rotation.z = Math.PI / 2; pipeH.position.set(4.1 - 1.2 - 1.5 + 0.0, 7.7, 0);
        const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.4, 20), mat(0x3a86ff, { roughness: 0.4 }));
        flange.position.set(4.1, 0.2, 0);
        g.add(pipeV, elbow, pipeH, flange);
        g.userData.water = water;
        return { g, col: { box: { hx: 4.9, hz: 2.6 } }, h: 9 };
      }
      // 6) Portinha laranja "novidades em breve"
      function orangeDoor() {
        const g = new THREE.Group();
        const frame = mat(0xf4f1de, { roughness: 0.6 });
        const orange = mat(0xb83a00, { roughness: 0.75 }); // laranja forte (a luz do quarto clareia bastante)
        [[-2.9, 4.9, 0.7, 9.8], [2.9, 4.9, 0.7, 9.8], [0, 9.8, 6.5, 0.7]].forEach(([x, y, w, h]) => {
          const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.0), frame);
          part.position.set(x, y, 0); part.castShadow = true;
          g.add(part);
        });
        const doorPivot = new THREE.Group();
        doorPivot.position.set(-2.55, 0, 0.1);
        const door = new THREE.Mesh(new THREE.BoxGeometry(5.1, 9.4, 0.4), orange);
        door.position.set(2.55, 4.75, 0); door.castShadow = true;
        doorPivot.add(door);
        [[2.55, 7.0], [2.55, 2.6]].forEach(([x, y]) => {
          const panel = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.2, 0.1), mat(0xcc4400, { roughness: 0.75 }));
          panel.position.set(x, y, 0.25);
          doorPivot.add(panel);
        });
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), mat(0xffd166, { metalness: 0.8, roughness: 0.2 }));
        knob.position.set(4.4, 4.6, 0.45);
        doorPivot.add(knob);
        doorPivot.rotation.y = -0.5; // entreaberta
        g.add(doorPivot);
        // Luz vazando pela fresta (porta entreaberta)
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 9.3), new THREE.MeshBasicMaterial({ color: 0xffe8a3 }));
        glow.position.set(0, 4.75, -0.1);
        // Fundo do batente (de costas a porta não fica vazada)
        const back = new THREE.Mesh(new THREE.BoxGeometry(5.2, 9.5, 0.15), frame);
        back.position.set(0, 4.75, -0.3);
        g.add(back);
        g.add(glow);
        // Placa "Novidades em breve"
        const c = document.createElement('canvas'); c.width = 512; c.height = 160;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#251f2b'; ctx.fillRect(0, 0, 512, 160);
        ctx.strokeStyle = '#ffceca'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, 500, 148);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 54px "Amatic SC", Pally-Medium, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('NOVIDADES EM BREVE', 256, 84);
        const sign = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.95, 0.25), [frame, frame, frame, frame, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }), frame]);
        sign.position.set(0, 11.4, 0.2);
        g.add(sign);
        g.userData.doorPivot = doorPivot;
        return { g, col: { box: { hx: 3.3, hz: 2.4 } }, h: 12.5 };
      }

      const builders = [piggyBank, bigBattery, armoredTruck, giantMug, waterJug, orangeDoor];
      CAREER_MILESTONES.forEach((m, i) => {
        const spot = CAREER_SPOTS[i];
        const built = builders[i]();
        const [ox, oz] = spot.obj;
        built.g.position.set(ox, surfaceY(spot.level), oz);
        built.g.rotation.y = spot.rotY;
        built.g.name = `Marco ${m.portal}: ${m.company}`;
        built.g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        scene.add(built.g);
        registerOccluderTree(built.g);
        const obs = Object.assign({ x: ox, z: oz, r: built.col.r || Math.max(built.col.box.hx, built.col.box.hz), name: `${m.title.toUpperCase()} · ${m.company.toUpperCase()}`, isStatic: true, level: spot.level, h: built.h }, built.col.box ? { box: built.col.box, boxRot: spot.rotY } : {});
        obstacles.push(obs);
        careerInteractives.push({
          id: 'career_' + m.portal, careerIndex: i,
          name: `Portal ${m.portal} · ${m.company}`,
          point: spot.pin, y: surfaceY(spot.level), level: spot.level,
          object: built.g
        });
      });
    })();

    // ============================================================================
    // RABISCOS DO LÁPIS DE COR (o lápis desenha livremente sobre a mesa)
    // ============================================================================
    const TRACK_W = 168, TRACK_D = 98;
    const raceTrackCanvas = document.createElement('canvas');
    raceTrackCanvas.width = 1024;
    raceTrackCanvas.height = 600;
    const rtCtx = raceTrackCanvas.getContext('2d');
    const raceTrackTexture = new THREE.CanvasTexture(raceTrackCanvas);
    const raceTrackPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK_W, TRACK_D),
      new THREE.MeshBasicMaterial({
        map: raceTrackTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
      })
    );
    raceTrackPlane.rotation.x = -Math.PI / 2;
    raceTrackPlane.position.set(0, 0.18, 0);
    raceTrackPlane.renderOrder = 2;
    deskWorld.add(raceTrackPlane);

    let crayonHue = 0;
    let lastCrayonPoint = null;
    function revealTrackAtWorldPos(wx, wz, pixelRadius = 7) {
      const cx = ((wx + TRACK_W / 2) / TRACK_W) * 1024;
      const cy = ((wz + TRACK_D / 2) / TRACK_D) * 600;
      crayonHue = (crayonHue + 1.2) % 360;
      rtCtx.strokeStyle = `hsla(${crayonHue}, 85%, 60%, 0.92)`;
      rtCtx.lineWidth = pixelRadius * 2;
      rtCtx.lineCap = 'round';
      rtCtx.beginPath();
      if (lastCrayonPoint && Math.hypot(cx - lastCrayonPoint.x, cy - lastCrayonPoint.y) < 40) rtCtx.moveTo(lastCrayonPoint.x, lastCrayonPoint.y);
      else rtCtx.moveTo(cx, cy);
      rtCtx.lineTo(cx, cy);
      rtCtx.stroke();
      lastCrayonPoint = { x: cx, y: cy };
      raceTrackTexture.needsUpdate = true;
    }
    // Camada temporária dos lápis comuns (some sozinha): traços guardados com prazo de validade
    const tempDrawCanvas = document.createElement('canvas');
    tempDrawCanvas.width = 1024; tempDrawCanvas.height = 600;
    const tdCtx = tempDrawCanvas.getContext('2d');
    const tempDrawTexture = new THREE.CanvasTexture(tempDrawCanvas);
    const tempDrawPlane = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, TRACK_D), new THREE.MeshBasicMaterial({ map: tempDrawTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 }));
    tempDrawPlane.rotation.x = -Math.PI / 2;
    tempDrawPlane.position.set(0, 0.185, 0);
    tempDrawPlane.renderOrder = 2;
    deskWorld.add(tempDrawPlane);
    const tempStrokes = [];
    let lastTempPoint = null;
    function drawTempStroke(st) {
      tdCtx.strokeStyle = st.color; tdCtx.lineWidth = st.w; tdCtx.lineCap = 'round';
      tdCtx.beginPath(); tdCtx.moveTo(st.x0, st.y0); tdCtx.lineTo(st.x1, st.y1); tdCtx.stroke();
    }
    function revealTempAt(wx, wz, opts, pixelRadius = 7) {
      const cx = ((wx + TRACK_W / 2) / TRACK_W) * 1024, cy = ((wz + TRACK_D / 2) / TRACK_D) * 600;
      const from = lastTempPoint && Math.hypot(cx - lastTempPoint.x, cy - lastTempPoint.y) < 40 ? lastTempPoint : { x: cx, y: cy };
      const st = { x0: from.x, y0: from.y, x1: cx, y1: cy, w: pixelRadius * 2, color: `hsla(${opts.hue}, 85%, 58%, 0.92)`, until: opts.until };
      tempStrokes.push(st);
      if (tempStrokes.length > 4000) tempStrokes.shift();
      drawTempStroke(st);
      lastTempPoint = { x: cx, y: cy };
      tempDrawTexture.needsUpdate = true;
    }
    function resetRaceTrackCanvas() {
      rtCtx.clearRect(0, 0, 1024, 600);
      lastCrayonPoint = null;
      raceTrackTexture.needsUpdate = true;
    }
    resetRaceTrackCanvas();

    // ---------- Pintar a PISTA com o lápis (mesa, rampas e chão) ----------
    // Cada amostra da pista guarda a cor do giz (0 = sem tinta). Salvo no aparelho para dar para completar aos poucos.
    const TRACK_PAINT_KEY = 'fire_engine_track_paint_v1';
    const trackPaintHue = new Uint8Array(trackSamples.length); // 0 = sem tinta; 1..255 = matiz
    const trackTempHue = new Uint8Array(trackSamples.length);   // tinta temporária dos lápis comuns
    const trackTempUntil = new Float32Array(trackSamples.length);
    const nowSec = () => performance.now() / 1000;
    let trackPaintedCount = 0, trackPaintSaveTimer = null, trackPaintDirty = false;
    function applyTrackPaintSample(k) {
      const N = trackSamples.length;
      const paint = trackMesh.geometry.attributes.aPaint, hue = trackMesh.geometry.attributes.aHue;
      const hb = trackTempHue[k] && trackTempUntil[k] > nowSec() ? trackTempHue[k] : trackPaintHue[k];
      const h = hb ? (hb - 1) / 254 : 0;
      const v = hb ? 1 : 0;
      [k, k === 0 ? N : -1].forEach((vk) => {
        if (vk < 0) return;
        paint.setX(vk * 2, v); paint.setX(vk * 2 + 1, v);
        hue.setX(vk * 2, h); hue.setX(vk * 2 + 1, h);
      });
    }
    function paintTrackAt(x, y, z, temp = null) {
      // Amostra mais próxima no mesmo andar (a altura evita pintar a pista do chão estando na mesa e vice-versa)
      let best = -1, bestD = Infinity;
      for (let k = 0; k < trackSamples.length; k++) {
        const s = trackSamples[k];
        if (Math.abs(s.y - y) > 5) continue;
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0 || Math.sqrt(bestD) > TRACK_WIDTH / 2 + 1.5) return false;
      const N = trackSamples.length;
      if (temp) {
        // Lápis comum: pinta por cima, mas só até o prazo; não conta para a pista mágica nem é salvo
        const hb = 1 + Math.round((temp.hue / 360) * 254);
        for (let o = -3; o <= 3; o++) {
          const k = ((best + o) % N + N) % N;
          trackTempHue[k] = hb; trackTempUntil[k] = temp.until;
          applyTrackPaintSample(k);
        }
        trackMesh.geometry.attributes.aPaint.needsUpdate = true;
        trackMesh.geometry.attributes.aHue.needsUpdate = true;
        return true;
      }
      const hueByte = 1 + Math.round((crayonHue / 360) * 254);
      let changed = false;
      for (let o = -3; o <= 3; o++) {
        const k = ((best + o) % N + N) % N;
        if (!trackPaintHue[k]) trackPaintedCount++;
        if (trackPaintHue[k] !== hueByte) { trackPaintHue[k] = hueByte; applyTrackPaintSample(k); changed = true; }
      }
      if (changed) {
        trackMesh.geometry.attributes.aPaint.needsUpdate = true;
        trackMesh.geometry.attributes.aHue.needsUpdate = true;
        trackPaintDirty = true;
        clearTimeout(trackPaintSaveTimer);
        trackPaintSaveTimer = setTimeout(saveTrackPaint, 1500);
        updateRainbowTrackProgress();
      }
      return true;
    }
    function saveTrackPaint() {
      if (!trackPaintDirty) return;
      trackPaintDirty = false;
      let s = '';
      for (let i = 0; i < trackPaintHue.length; i++) s += String.fromCharCode(trackPaintHue[i]);
      try { localStorage.setItem(TRACK_PAINT_KEY, btoa(s)); } catch (e) { /* ignora */ }
    }
    function restoreTrackPaint() {
      try {
        const raw = localStorage.getItem(TRACK_PAINT_KEY);
        if (raw) {
          const s = atob(raw);
          if (s.length === trackPaintHue.length) {
            for (let i = 0; i < s.length; i++) { trackPaintHue[i] = s.charCodeAt(i); if (trackPaintHue[i]) trackPaintedCount++; applyTrackPaintSample(i); }
            trackMesh.geometry.attributes.aPaint.needsUpdate = true;
            trackMesh.geometry.attributes.aHue.needsUpdate = true;
          }
        }
      } catch (e) { /* dados antigos/ inválidos: começa do zero */ }
      if (achievementState.unlocked.rainbowTrack) trackPaintUniforms.uMagic.value = 1;
    }
    // A tinta dos lápis comuns vai sumindo: confere a cada segundo o que venceu
    let lastPaintSweep = 0;
    function sweepTempPaint(time) {
      if (time - lastPaintSweep < 1) return;
      lastPaintSweep = time;
      const now = nowSec();
      let changed = false;
      for (let k = 0; k < trackTempHue.length; k++) {
        if (trackTempHue[k] && trackTempUntil[k] <= now) { trackTempHue[k] = 0; applyTrackPaintSample(k); changed = true; }
      }
      if (changed) {
        trackMesh.geometry.attributes.aPaint.needsUpdate = true;
        trackMesh.geometry.attributes.aHue.needsUpdate = true;
      }
      if (tempStrokes.some((st) => st.until <= now)) {
        for (let i = tempStrokes.length - 1; i >= 0; i--) if (tempStrokes[i].until <= now) tempStrokes.splice(i, 1);
        tdCtx.clearRect(0, 0, 1024, 600);
        tempStrokes.forEach(drawTempStroke);
        tempDrawTexture.needsUpdate = true;
      }
    }
    function drawWithPencil(item, x, y, z, dt) {
      const pen = item.pencil || { special: true };
      if (!pen.special) {
        if (pen.ink <= 0) {
          if (!pen.warned) { pen.warned = true; showCarSpeech(`Acabou a tinta do lápis ${pen.label}!`, 2400); setStatusBanner(`🖍️ O lápis ${pen.label} ficou sem tinta. Pegue outro lápis!`, '#ffb703'); }
          return;
        }
        pen.ink = Math.max(0, pen.ink - dt);
        item.group.scale.x = 0.4 + 0.6 * (pen.ink / pen.maxInk); // o lápis vai encurtando
      }
      // Duração da tinta comum: 2 min (quase sem tinta) a 6 min (lápis novo)
      const temp = pen.special ? null : { hue: pen.hue, until: nowSec() + 120 + 240 * (pen.ink / pen.maxInk) };
      const onTrack = paintTrackAt(x, y, z, temp);
      if (!onTrack && y > -15) { if (temp) revealTempAt(x, z, temp); else revealTrackAtWorldPos(x, z); }
      else if (pen.special) crayonHue = (crayonHue + 1.2) % 360;
      logInteractionEvent(pen.special ? '🖍️ Pintando com o lápis mágico!' : `🖍️ Pintando com o lápis ${pen.label}!`);
      pencilDrawTime += dt;
      if (pencilDrawTime > 3) unlockAchievement('artist');
    }
    // Conquista secreta "Pista mágica": 98% da pista pintada
    function updateRainbowTrackProgress() {
      const pct = Math.floor((trackPaintedCount / trackSamples.length) * 100);
      if (achievementState.unlocked.rainbowTrack) return;
      if (pct >= 98) {
        unlockAchievement('rainbowTrack');
        trackPaintUniforms.uMagic.value = 1;
        notify({ type: 'achievement', title: '✨ Pista mágica!', description: 'A pista inteira ganhou cores de arco-íris para sempre.', duration: 6000 });
        showCarSpeech('Que pista mais linda! 🌈', 2600);
        for (let i = 0; i < 8; i++) {
          const s = trackSamples[Math.floor(Math.random() * trackSamples.length)];
          confettiBurst(s.x, s.y + 1, s.z, 30);
        }
      } else {
        progressAchievement('rainbowTrack', pct, true);
      }
    }
    function isCarOnRainbowTrack(px, pz, py) {
      if (trackPaintUniforms.uMagic.value < 0.5) return false;
      const x = px !== undefined ? px : vehicle.position.x;
      const z = pz !== undefined ? pz : vehicle.position.z;
      const y = py !== undefined ? py : vehicle.position.y;
      for (let k = 0; k < trackSamples.length; k += 3) {
        const s = trackSamples[k];
        if (Math.abs(s.y - y) < 4 && (s.x - x) ** 2 + (s.z - z) ** 2 < (TRACK_WIDTH / 2 + 0.8) ** 2) {
          return true;
        }
      }
      return false;
    }

    // Faíscas de arco-íris saindo das rodas traseiras quando a pista está mágica + recarga até 130%
    let magicTrailAcc = 0;
    function updateMagicTrail(dt, time) {
      trackPaintUniforms.uTrackTime.value = time;
      if (trackPaintUniforms.uMagic.value < 0.5 || carAirborne) return;
      const near = isCarOnRainbowTrack();
      if (!near) return;

      // Ao concluir a conquista Pista Mágica, andar sobre a pista recarrega continuamente até 130% (sem sobrecarregar/explodir!)
      if (carBattery < 130) {
        carBattery = Math.min(130, carBattery + dt * 14);
        if (carBattery >= 10) batteryLowWarned = false;
        updateBatteryHUD();
      }

      if (Math.abs(carSpeed) < 0.06) return;
      const vp = vehicle.position;
      magicTrailAcc += dt * (18 + Math.abs(carSpeed) * 30);
      const back = -1.9, sideX = 1.15, sn = Math.sin(carAngle), cs = Math.cos(carAngle);
      while (magicTrailAcc >= 1) {
        magicTrailAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const lx = side * sideX, lz = back;
        const wx = vp.x + lx * cs + lz * sn, wz = vp.z - lx * sn + lz * cs;
        const col = new THREE.Color().setHSL((time * 0.25 + Math.random() * 0.3) % 1, 0.85, 0.65).getHex();
        spawnFx(wx, vp.y + 0.25, wz, (Math.random() - 0.5) * 1.2, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 1.2, col, 0.16 + Math.random() * 0.1, -0.6, 0.9);
      }
    }

    // LÁPIS DE COR GIGANTE (Segure com o carrinho para desenhar/revelar a pista de corrida!)
    const pencilGroup = new THREE.Group();
    const pencilBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 7.2, 6),
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.35, flatShading: true })
    );
    pencilBody.rotation.z = Math.PI / 2;
    pencilBody.position.y = 0.45;
    pencilBody.castShadow = true;

    const pencilStripe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.43, 0.43, 0.8, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    pencilStripe.rotation.z = Math.PI / 2;
    pencilStripe.position.set(-2.8, 0.45, 0);

    const pencilWood = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 1.35, 6),
      new THREE.MeshStandardMaterial({ color: 0xe6c294, roughness: 0.6 })
    );
    pencilWood.rotation.z = -Math.PI / 2;
    pencilWood.position.set(4.25, 0.45, 0);

    const pencilLead = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.52, 6),
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.2 })
    );
    pencilLead.rotation.z = -Math.PI / 2;
    pencilLead.position.set(4.72, 0.45, 0);

    pencilGroup.add(pencilBody, pencilStripe, pencilWood, pencilLead);
    pencilGroup.position.set(-16, 0.05, 36);
    pencilGroup.rotation.y = 0.25;
    deskWorld.add(pencilGroup);

    // Lápis especial (arco-íris): tinta infinita e pintura permanente. Agora tem física (empurrável).
    const pencilObs = registerDynamicObstacle({
      obs: { x: -16, z: 36, r: 2.2, box: { hx: 4.4, hz: 0.45 }, h: 0.9, name: '✏️ LÁPIS MÁGICO (SEGURE COM [E] PARA PINTAR A PISTA!)' },
      group: pencilGroup, mass: 0.3, canTopple: false
    });
    registerGrabbable({
      id: 'colored_pencil',
      type: 'pencil',
      name: 'Lápis Mágico (arco-íris, tinta infinita)',
      group: pencilGroup,
      obs: pencilObs,
      initX: -16, initY: 0.05, initZ: 36, initRotY: 0.25,
      grabRadius: 6.0,
      pencil: { special: true }
    });
    // Lápis coloridos comuns: cada um tem uma carga de tinta que acaba (o lápis vai encurtando);
    // a pintura deles some depois de 2 a 6 minutos, conforme a tinta que ainda havia no lápis
    const COLOR_PENCILS = [
      ['Azul', 212, -48, -26, false], ['Verde', 128, -66, 10, false], ['Amarelo', 50, -8, 14, false], ['Laranja', 26, 50, -12, false],
      ['Roxo', 276, 12, 22, false], ['Rosa', 330, -66, 36, false], ['Turquesa', 182, -12, -50, true], ['Vermelho', 2, -125, -45, true], ['Lilás', 300, 20, -55, true]
    ];
    function createColorPencil([label, hue, x, z, floor]) {
      const g = new THREE.Group();
      const col = new THREE.Color().setHSL(hue / 360, 0.75, 0.55);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 6.4, 6), new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, flatShading: true }));
      body.rotation.z = Math.PI / 2; body.position.y = 0.38; body.castShadow = true;
      const label2 = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.7, flatShading: true }));
      label2.rotation.z = Math.PI / 2; label2.position.set(-0.6, 0.38, 0);
      const wood = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.15, 6), new THREE.MeshStandardMaterial({ color: 0xe6c294, roughness: 0.6 }));
      wood.rotation.z = -Math.PI / 2; wood.position.set(3.77, 0.38, 0);
      const lead = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.45, 6), new THREE.MeshStandardMaterial({ color: col, roughness: 0.25 }));
      lead.rotation.z = -Math.PI / 2; lead.position.set(4.18, 0.38, 0);
      g.add(body, label2, wood, lead);
      const y = floor ? FLOOR_SURFACE_Y : deskY(x, z);
      g.position.set(x, y + 0.02, z);
      g.rotation.y = Math.random() * Math.PI;
      (floor ? bedroomWorld : deskWorld).add(g);
      const obs = registerDynamicObstacle({ obs: { x, z, r: 2.0, box: { hx: 3.9, hz: 0.4 }, h: 0.8, name: `LÁPIS ${label.toUpperCase()}` }, group: g, mass: 0.15, canTopple: false });
      const maxInk = 25 + Math.random() * 20; // segundos desenhando
      registerGrabbable({
        id: 'pencil_' + label, type: 'pencil', name: `Lápis ${label}`, group: g, obs,
        initX: x, initY: y + 0.02, initZ: z, initRotY: g.rotation.y, grabRadius: 5.5,
        pencil: { special: false, hue, ink: maxInk, maxInk, label }
      });
    }
    COLOR_PENCILS.forEach(createColorPencil);

    // ============================================================================
    // NOVOS OBJETOS NA MESA 3X EXPANDIDA!
    // ============================================================================

    // 7. TRÊS PLANTAS DIFERENTES COM CRESCIMENTO GRADUAL (ENTRE 2 A 5 MINUTOS = 180s!)
    // growablePlants already declared
    const PLANT_GROWTH_DURATION = 180.0; // 3 minutos (180 segundos) para crescer gradualmente ao Nível 2!

    // Folhas em "cartões" com o mesmo shader de vento das árvores (folhas flexíveis, não blocos rígidos)
    // (o shader de folhagem é definido mais adiante: as malhas recebem o material dele assim que ele existir)
    const pendingLeafMeshes = [];
    const plantLeafMats = { succulent: [0x2e7d4f, 0x9be3a8], fern: [0x1b6b34, 0x86d96e] };
    function leafCardMesh(cards, colors) {
      const pos = [], uv = [], centers = [], shade = [], heights = [], idx = [];
      cards.forEach((c) => {
        const base = pos.length / 3;
        const tip = c.c.clone().addScaledVector(c.dir, c.len);
        const mid = c.c.clone().addScaledVector(c.dir, c.len * 0.5);
        [[-1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([sx, t, uu, vv]) => {
          const pnt = (t ? tip : c.c).clone().addScaledVector(c.side, sx * c.wid * 0.5 * (t ? 0.55 : 1));
          pos.push(pnt.x, pnt.y, pnt.z);
          uv.push(uu, vv);
          centers.push(mid.x, mid.y, mid.z);
          shade.push(c.shade);
          heights.push(c.h * (t ? 1 : 0.35));
        });
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
      g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
      g.setAttribute('aHeight', new THREE.Float32BufferAttribute(heights, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      g.boundingSphere.radius += 1.5;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colors[0] }));
      pendingLeafMeshes.push({ mesh, colors });
      return mesh;
    }
    const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
    function succulentCards() {
      const cards = [];
      [[0.15, 5, 0.25, 0.9], [0.5, 8, 0.75, 1.15], [0.85, 11, 1.15, 1.35]].forEach(([r, n, tilt, len], ring) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + ring * 0.4;
          const dir = V3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
          cards.push({ c: V3(Math.cos(a) * r, 0.05 + ring * -0.05, Math.sin(a) * r), dir, side: V3(-Math.sin(a), 0, Math.cos(a)), len, wid: 0.9, shade: 0.3 + ring * 0.3, h: 0.25 + ring * 0.12 });
        }
      });
      return cards;
    }
    function fernCards() {
      const cards = [];
      for (let f = 0; f < 9; f++) {
        const a = (f / 9) * Math.PI * 2 + Math.random() * 0.3, len = 2.6 + Math.random() * 0.6;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let l = 1; l <= 7; l++) {
          const u = l / 7, r = u * len, hy = Math.sin(u * Math.PI * 0.8) * len * 0.55 + 0.1;
          const cpt = V3(ca * r, hy, sa * r);
          const sz = 0.55 - u * 0.28;
          [-1, 1].forEach((side) => {
            const out = V3(-sa * side, -0.15, ca * side).normalize();
            cards.push({ c: cpt, dir: out, side: V3(ca, 0.25, sa).normalize(), len: sz * 1.5, wid: sz, shade: 0.25 + u * 0.7, h: 0.15 + u * 0.4 });
          });
        }
      }
      return cards;
    }

    function createGrowablePlant(type, name, x, z) {
      const pGroup = new THREE.Group();
      pGroup.position.set(x, 0, z);

      const potColor = type === 'cactus' ? 0xc8643b : type === 'fern' ? 0x2c353d : 0xe6dfd5;
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 1.4, 2.6, 12),
        new THREE.MeshStandardMaterial({ color: potColor, roughness: 0.65, flatShading: true })
      );
      pot.position.y = 1.3; pot.castShadow = true;
      pGroup.add(pot);

      const foliageGroup = new THREE.Group();
      foliageGroup.position.y = 2.5;
      pGroup.add(foliageGroup);

      const flowersGroup = new THREE.Group();
      flowersGroup.visible = false;
      foliageGroup.add(flowersGroup);

      if (type === 'succulent') {
        const rosette = leafCardMesh(succulentCards(), plantLeafMats.succulent);
        rosette.position.y = -0.2;
        foliageGroup.add(rosette);
        const fl = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65, 0), new THREE.MeshBasicMaterial({ color: 0xff4081 }));
        fl.position.set(0, 1.4, 0); flowersGroup.add(fl);
      } else if (type === 'cactus') {
        const cacMat = new THREE.MeshStandardMaterial({ color: 0x2d8a4e, roughness: 0.5 });
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 3.8, 12), cacMat);
        trunk.position.y = 1.6; trunk.castShadow = true; foliageGroup.add(trunk);
        const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.8, 10), cacMat);
        armL.position.set(-1.0, 2.0, 0); armL.rotation.z = -0.5; foliageGroup.add(armL);
        const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.6, 10), cacMat);
        armR.position.set(1.0, 1.6, 0); armR.rotation.z = 0.5; foliageGroup.add(armR);

        const fl1 = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffeb3b }));
        fl1.position.set(0, 3.6, 0);
        const fl2 = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 10), new THREE.MeshBasicMaterial({ color: 0xff5722 }));
        fl2.position.set(-1.35, 2.8, 0);
        flowersGroup.add(fl1, fl2);
      } else {
        foliageGroup.add(leafCardMesh(fernCards(), plantLeafMats.fern));
        for (let i = 0; i < 5; i++) {
          const fl = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 8), new THREE.MeshBasicMaterial({ color: 0xe040fb }));
          const ang = (i / 5) * Math.PI * 2;
          fl.position.set(Math.cos(ang) * 1.2, 1.4, Math.sin(ang) * 1.2);
          flowersGroup.add(fl);
        }
      }

      deskWorld.add(pGroup);
      const plantObj = {
        name,
        group: pGroup,
        initX: x, initZ: z,
        foliageGroup,
        flowersGroup,
        isWatered: false,
        growthElapsed: 0, // Segundos acumulados de crescimento (0 a 180s)
        level: 1,
        targetScale: 1.0,
        obs: { x, z, r: 2.1, h: 5, name: `${name} (NÍVEL 1)` },
        wob: { ax: 0, az: 0, vx: 0, vz: 0 }
      };
      // Vaso com física: o carrinho empurra, ele desliza e balança (antes era fixo)
      registerDynamicObstacle({ obs: plantObj.obs, group: pGroup, mass: 1.1, canTopple: true });
      Object.defineProperty(plantObj, 'x', { get: () => plantObj.obs.x, set: () => {} });
      Object.defineProperty(plantObj, 'z', { get: () => plantObj.obs.z, set: () => {} });
      growablePlants.push(plantObj);
      registerGrabbable({
        id: 'plant_' + type, name, group: pGroup, obs: plantObj.obs,
        initX: x, initY: 0, initZ: z, initRotY: 0, grabRadius: 5.2,
        onRelease: (nx, nz) => { plantObj.x = nx; plantObj.z = nz; }
      });
    }

    createGrowablePlant('succulent', 'PLANTINHA SUCULENTA', 28, -4);
    createGrowablePlant('cactus', 'CACTO DO DESERTO', -42, -22);
    createGrowablePlant('fern', 'SAMAMBAIA COSTELA-DE-ADÃO', 48, 22);

    // 8. AQUÁRIO AQUASCAPE PREMIUM COM 3 PEIXES DETALHADOS (A ~10 CM DA BORDA LATERAL DA MESA!)
    const aquariumGroup = new THREE.Group();
    const AQ_X = DESK_HALF_W - 8.8; // 81.2 (a ~10cm da borda x=90)
    const AQ_Z = -4.0;
    aquariumGroup.position.set(AQ_X, 0, AQ_Z);
    aquariumGroup.rotation.y = Math.PI / 2;

    const aqFrameMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.3, metalness: 0.5 });

    // Base estrutural preta com tapete de EVA
    const aqBase = new THREE.Mesh(new THREE.BoxGeometry(18.6, 0.9, 11.4), aqFrameMat);
    aqBase.position.y = 0.45;
    aqBase.castShadow = true;
    aquariumGroup.add(aqBase);

    // 4 Colunas de canto pretas + Moldura superior fina
    [[-9.1, -5.5], [9.1, -5.5], [-9.1, 5.5], [9.1, 5.5]].forEach(([cx, cz]) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9.2, 0.35), aqFrameMat);
      post.position.set(cx, 5.2, cz);
      aquariumGroup.add(post);
    });
    const topRimF = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.28, 0.32), aqFrameMat);
    topRimF.position.set(0, 9.7, 5.5);
    const topRimB = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.28, 0.32), aqFrameMat);
    topRimB.position.set(0, 9.7, -5.5);
    const topRimL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 11.3), aqFrameMat);
    topRimL.position.set(-9.1, 9.7, 0);
    const topRimR = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 11.3), aqFrameMat);
    topRimR.position.set(9.1, 9.7, 0);
    aquariumGroup.add(topRimF, topRimB, topRimL, topRimR);

    // Luminária LED Suspensa de Aquário (Overhead Aquascape LED Bar + Hastes Metálicas)
    [-6.5, 6.5].forEach((lx) => {
      const rodV = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.2, 12), inoxMat);
      rodV.position.set(lx, 11.2, -5.3);
      const rodH = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.2, 12), inoxMat);
      rodH.rotation.x = Math.PI / 2;
      rodH.position.set(lx, 12.7, -2.8);
      aquariumGroup.add(rodV, rodH);
    });
    const ledFixture = new THREE.Mesh(new THREE.BoxGeometry(15.5, 0.35, 2.4), aqFrameMat);
    ledFixture.position.set(0, 12.7, -0.4);
    ledFixture.castShadow = true;
    const ledStrip = new THREE.Mesh(
      new THREE.PlaneGeometry(14.8, 1.8),
      new THREE.MeshBasicMaterial({ color: 0xb8f4ff })
    );
    ledStrip.rotation.x = Math.PI / 2;
    ledStrip.position.set(0, 12.51, -0.4);
    const aqLight = new THREE.PointLight(0x40e8ff, 0.85, 22);
    aqLight.position.set(0, 10.5, 0);
    aquariumGroup.add(ledFixture, ledStrip); // sem PointLight: a fita de LED emissiva já ilumina o aquário visualmente

    // Substrato de Areia de Quartzo e Cascalho de Rio em relevo
    const aqSand = new THREE.Mesh(
      new THREE.BoxGeometry(17.8, 1.1, 10.6),
      new THREE.MeshStandardMaterial({ color: 0xd9be8f, roughness: 0.92 })
    );
    aqSand.position.y = 1.25;
    aquariumGroup.add(aqSand);

    // Rochas Aquascape (Dragon Stone) + Tronco/Arco Submerso no centro
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x5c636a, roughness: 0.85, flatShading: true });
    [
      { x: -5.2, y: 2.6, z: -1.5, s: [1.8, 2.4, 1.5] },
      { x: -3.5, y: 2.1, z: 1.2, s: [1.3, 1.4, 1.2] },
      { x: 4.8, y: 2.8, z: -1.8, s: [2.0, 2.8, 1.6] },
      { x: 3.2, y: 2.0, z: 1.8, s: [1.2, 1.3, 1.4] }
    ].forEach((rk) => {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.0, 0), rockMat);
      rock.position.set(rk.x, rk.y, rk.z);
      rock.scale.set(...rk.s);
      rock.rotation.set(0.3, 0.5, 0.2);
      rock.castShadow = true;
      aquariumGroup.add(rock);
    });

    // Arco de Tronco Submerso (Driftwood Arch por onde os 3 peixes nadam!)
    const woodArch = new THREE.Mesh(
      new THREE.TorusGeometry(2.3, 0.42, 10, 20, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x6e472b, roughness: 0.88, flatShading: true })
    );
    woodArch.position.set(0, 1.75, 0.2);
    woodArch.rotation.y = 0.25;
    aquariumGroup.add(woodArch);

    // Filtro Interno de Canto + Pedra Porosa com Bolhas de Ar 3D Subindo!
    const internalFilter = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 5.2, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x1e2229, roughness: 0.4 })
    );
    internalFilter.position.set(-7.6, 5.2, -3.9);
    const airStone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.65, 0.4, 14),
      new THREE.MeshStandardMaterial({ color: 0x29b6f6, roughness: 0.7 })
    );
    airStone.position.set(-6.8, 1.9, 2.6);
    aquariumGroup.add(internalFilter, airStone);

    // Bolhas de ar 3D que sobem continuamente da pedra porosa
    const aquariumBubbles = [];
    const bubbleGeo = new THREE.SphereGeometry(0.14, 10, 10);
    const bubbleMat = new THREE.MeshStandardMaterial({ color: 0xeafcff, transparent: true, opacity: 0.6, roughness: 0.05, metalness: 0.2, emissive: 0x9fe8ff, emissiveIntensity: 0.25 });
    // Duas saídas de bolhas: pedra porosa (colunas finas) e bico do filtro (bolhas maiores e mais rápidas)
    const BUBBLE_SOURCES = [{ x: -6.8, y: 2.1, z: 2.6, size: 1 }, { x: -7.6, y: 6.6, z: -2.9, size: 1.4 }];
    for (let i = 0; i < 22; i++) {
      const src = BUBBLE_SOURCES[i < 14 ? 0 : 1];
      const bMesh = new THREE.Mesh(bubbleGeo, bubbleMat);
      const t = (i % 14) / 14;
      bMesh.position.set(src.x, src.y + t * (9.0 - src.y), src.z);
      aquariumGroup.add(bMesh);
      aquariumBubbles.push({
        mesh: bMesh, src,
        speed: (1.5 + Math.random() * 1.0) * (src.size > 1 ? 1.3 : 1),
        wobble: Math.random() * Math.PI * 2,
        size: (0.6 + Math.random() * 0.7) * src.size
      });
    }

    // Plantas Aquáticas (Vallisneria e Anubias em dois tons de verde)
    const plantGreen1 = new THREE.MeshStandardMaterial({ color: 0x1ebd68, roughness: 0.4 });
    const plantGreen2 = new THREE.MeshStandardMaterial({ color: 0x0f8a48, roughness: 0.4 });
    for (let i = 0; i < 11; i++) {
      const h = 2.6 + (i % 4) * 1.1;
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, h, 0.08),
        i % 2 === 0 ? plantGreen1 : plantGreen2
      );
      blade.position.set(-7.2 + i * 1.45, 1.6 + h * 0.5, -3.4 + (i % 3) * 0.9);
      blade.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.12;
      aquariumGroup.add(blade);
    }

    // Água Cristalina Azul-Turquesa + Superfície Superior com Brilho
    // Volume de água: mais escuro no fundo, claro perto da superfície, com faixas de luz ondulando
    const aqWater = new THREE.Mesh(
      new THREE.BoxGeometry(17.9, 7.6, 10.7),
      new THREE.ShaderMaterial({
        uniforms: { uTime: liquidUniforms.uTime },
        vertexShader: `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime; varying vec3 vPos;
          ${GLSL_CAUSTIC}
          void main() {
            float h = clamp((vPos.y + 3.8) / 7.6, 0.0, 1.0);
            vec3 deep = vec3(0.02, 0.32, 0.55), shallow = vec3(0.35, 0.86, 0.98);
            vec3 col = mix(deep, shallow, pow(h, 0.8));
            float c = caustic(vec2(vPos.x * 0.32 + vPos.y * 0.12, vPos.z * 0.32 - vPos.y * 0.1), uTime * 0.7);
            col += c * (0.12 + 0.18 * h) * vec3(0.7, 1.0, 1.0);
            gl_FragColor = vec4(col, 0.30 + (1.0 - h) * 0.2);
          }`,
        transparent: true,
        depthWrite: false
      })
    );
    aqWater.position.y = 5.45;
    aqWater.renderOrder = 1;
    aquariumGroup.add(aqWater);

    // Superfície ondulada (malha com ondas no vértice) + brilho das cáusticas
    const aqSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(17.9, 10.7, 36, 22),
      new THREE.ShaderMaterial({
        uniforms: { uTime: liquidUniforms.uTime },
        vertexShader: `
          uniform float uTime; varying vec2 vUv; varying float vWave;
          void main() {
            vUv = uv;
            vec3 p = position;
            float w = sin(p.x * 1.1 + uTime * 1.6) * 0.06 + sin(p.y * 1.4 - uTime * 1.3) * 0.05 + sin((p.x + p.y) * 2.3 + uTime * 2.1) * 0.025;
            p.z += w;
            vWave = w;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `
          uniform float uTime; varying vec2 vUv; varying float vWave;
          ${GLSL_CAUSTIC}
          void main() {
            vec2 p = (vUv - 0.5) * vec2(17.9, 10.7) * 0.28;
            float c = caustic(p, uTime * 1.1);
            vec3 col = mix(vec3(0.25, 0.78, 0.95), vec3(0.85, 1.0, 1.0), c * 0.8 + vWave * 4.0);
            gl_FragColor = vec4(col, 0.42 + c * 0.25);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    aqSurface.rotation.x = -Math.PI / 2;
    aqSurface.position.y = 9.24;
    aqSurface.renderOrder = 2;
    aquariumGroup.add(aqSurface);

    // Cáusticas dançando na areia (luz somada por cima do substrato)
    const aqSandCaustics = new THREE.Mesh(
      new THREE.PlaneGeometry(17.6, 10.4),
      new THREE.ShaderMaterial({
        uniforms: { uTime: liquidUniforms.uTime },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime; varying vec2 vUv;
          ${GLSL_CAUSTIC}
          void main() {
            vec2 p = (vUv - 0.5) * vec2(17.6, 10.4) * 0.42;
            float c = caustic(p, uTime * 1.3) + caustic(p * 1.7 + 3.0, uTime * 0.9) * 0.5;
            gl_FragColor = vec4(vec3(0.55, 0.95, 1.0) * c * 0.55, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    aqSandCaustics.rotation.x = -Math.PI / 2;
    aqSandCaustics.position.y = 1.82;
    aquariumGroup.add(aqSandCaustics);

    // Raios de luz da luminária atravessando a água (planos suaves e aditivos)
    const aqShaftMat = new THREE.ShaderMaterial({
      uniforms: { uTime: liquidUniforms.uTime },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; varying vec2 vUv;
        void main() {
          float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
          float fade = pow(vUv.y, 1.6);
          float flick = 0.75 + 0.25 * sin(uTime * 1.3 + vUv.x * 6.0);
          gl_FragColor = vec4(vec3(0.6, 0.95, 1.0) * edge * fade * flick * 0.22, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    [[-5.5, 0.18], [-1.2, -0.12], [3.4, 0.1], [6.8, -0.2]].forEach(([sx, tilt]) => {
      const shaft = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 7.2), aqShaftMat);
      shaft.position.set(sx, 5.5, -0.4);
      shaft.rotation.z = tilt;
      aquariumGroup.add(shaft);
    });

    // Paredes de Vidro Temperado Cristalino
    const aqGlass = new THREE.Mesh(
      new THREE.BoxGeometry(18.2, 8.8, 11.0),
      new THREE.MeshStandardMaterial({ color: 0xe8faff, transparent: true, opacity: 0.12, roughness: 0.04, metalness: 0.1, depthWrite: false })
    );
    aqGlass.position.y = 5.25;
    aqGlass.renderOrder = 3; // vidro por último: não esconde a água de dentro
    aquariumGroup.add(aqGlass);

    // APENAS 3 PEIXES TROPICAIS DETALHADOS (1: Peixe-Palhaço Nemo, 2: Blue Tang Dory, 3: Acará-Bandeira Dourado!)
    const fishes = [];
    const fishSpecs = [
      { name: 'Nemo (Clownfish)', bodyCol: 0xff5722, stripeCol: 0xffffff, finCol: 0xff7043, scale: 1.15, y: 4.2, rx: 5.2, rz: 2.6, speed: 0.95, phase: 0 },
      { name: 'Dory (Blue Tang)', bodyCol: 0x1565c0, stripeCol: 0x111317, finCol: 0xffea00, scale: 1.25, y: 6.4, rx: 5.6, rz: 2.8, speed: 1.1, phase: 2.1 },
      { name: 'Gold Angelfish', bodyCol: 0xffca28, stripeCol: 0xff8f00, finCol: 0xffe082, scale: 1.1, y: 5.2, rx: 4.4, rz: 2.2, speed: 0.82, phase: 4.2 }
    ];

    fishSpecs.forEach((sp) => {
      const fGroup = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({ color: sp.bodyCol, roughness: 0.18 });
      const stripeMat = new THREE.MeshStandardMaterial({ color: sp.stripeCol, roughness: 0.22 });
      const finMat = new THREE.MeshStandardMaterial({ color: sp.finCol, roughness: 0.25 });

      // Corpo esculpido do peixe
      const fBody = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 14), bodyMat);
      fBody.scale.set(1.65, 1.05, 0.55);
      fGroup.add(fBody);

      // Faixas verticais características (como as listras brancas do Peixe-Palhaço!)
      [-0.18, 0.22].forEach((sx) => {
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.18, 16), stripeMat);
        stripe.rotation.z = Math.PI / 2;
        stripe.scale.set(1.06, 1, 0.58);
        stripe.position.x = sx;
        fGroup.add(stripe);
      });

      // Nadadeira Dorsal Superior + Nadadeira Ventral
      const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.65, 5), finMat);
      dorsal.rotation.z = 0.55;
      dorsal.scale.set(1, 1, 0.35);
      dorsal.position.set(-0.08, 0.58, 0);
      fGroup.add(dorsal);

      // Cauda Bifurcada Articulada
      const tailFin = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.72, 4), finMat);
      tailFin.rotation.z = Math.PI / 2;
      tailFin.scale.set(1, 1, 0.32);
      tailFin.position.x = -0.92;
      fGroup.add(tailFin);

      // Olhinhos bilateralmente nos dois lados da cabeça
      [-0.24, 0.24].forEach((ez) => {
        const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        eyeWhite.position.set(0.55, 0.12, ez);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0x090a0c }));
        pupil.position.set(0.60, 0.12, ez * 1.15);
        fGroup.add(eyeWhite, pupil);
      });

      fGroup.scale.setScalar(sp.scale);
      aquariumGroup.add(fGroup);
      fishes.push({
        group: fGroup,
        tailFin,
        speed: sp.speed,
        radiusX: sp.rx,
        radiusZ: sp.rz,
        y: sp.y,
        phase: sp.phase
      });
    });

    deskWorld.add(aquariumGroup);
    obstacles.push({ x: AQ_X, z: AQ_Z, r: 8.5, box: { hx: 9.4, hz: 5.8 }, boxRot: 0, name: 'AQUÁRIO AQUASCAPE COM 3 PEIXES TROPICAIS (A 10CM DA BORDA)' });

    let hdmi1Connected = false;

    // ============================================================================
    // CABO HDMI INTERATIVO (NOTEBOOK -> MONITOR 1)
    // ============================================================================
    const hdmiCables = [];

    function createInteractiveHdmiCable(config) {
      const plugGroup = new THREE.Group();
      plugGroup.position.set(config.initPlugX, 0.28, config.initPlugZ);

      const plugHousing = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 0.48, 1.8),
        new THREE.MeshStandardMaterial({ color: config.badgeColor, roughness: 0.3 })
      );
      plugHousing.castShadow = true;
      const goldTip = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 0.26, 0.65),
        new THREE.MeshStandardMaterial({ color: 0xffd54f, metalness: 0.85, roughness: 0.2 })
      );
      goldTip.position.set(0, 0, -1.1);
      plugGroup.add(plugHousing, goldTip);
      deskWorld.add(plugGroup);

      const segCount = 14;
      const segMeshes = [];
      const segMat = new THREE.MeshStandardMaterial({ color: config.cableColor, roughness: 0.5 });
      for (let i = 0; i < segCount; i++) {
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1, 8), segMat);
        seg.castShadow = true;
        deskWorld.add(seg);
        segMeshes.push(seg);
      }

      const cableObj = {
        ...config,
        plugGroup,
        segMeshes,
        connected: false,
        updateCableCurve() {
          const p0 = config.startPos;
          const p2 = plugGroup.position;
          const midX = (p0.x + p2.x) * 0.5;
          const midZ = (p0.z + p2.z) * 0.5 + 3.5;
          const curve = new THREE.QuadraticBezierCurve3(
            p0,
            new THREE.Vector3(midX, 0.22, midZ),
            new THREE.Vector3(p2.x, 0.28, p2.z)
          );
          const pts = curve.getPoints(segCount);
          for (let i = 0; i < segCount; i++) {
            const a = pts[i], b = pts[i + 1];
            const seg = segMeshes[i];
            seg.position.copy(a).lerp(b, 0.5);
            const dist = a.distanceTo(b);
            seg.scale.set(1, Math.max(0.1, dist), 1);
            seg.quaternion.setFromUnitVectors(
              new THREE.Vector3(0, 1, 0),
              b.clone().sub(a).normalize()
            );
          }
        }
      };
      cableObj.updateCableCurve();
      hdmiCables.push(cableObj);

      registerGrabbable({
        id: config.id,
        type: 'hdmi',
        name: config.name,
        group: plugGroup,
        initX: config.initPlugX, initY: 0.28, initZ: config.initPlugZ, initRotY: 0,
        grabRadius: 5.5,
        cableRef: cableObj,
        onDrag: () => {
          cableObj.updateCableCurve();
          const distToTarget = Math.hypot(
            plugGroup.position.x - config.targetPos.x,
            plugGroup.position.z - config.targetPos.z
          );
          if (!cableObj.connected && distToTarget < 6.8) {
            cableObj.connected = true;
            if (typeof progressAchievement === 'function') {
              progressAchievement('hdmi', hdmiCables.filter(c => c.connected).length, true);
            }
            plugGroup.position.set(config.targetPos.x, 0.35, config.targetPos.z + 1.8);
            plugGroup.rotation.y = 0;
            cableObj.updateCableCurve();
            if (heldItem && heldItem.id === config.id) {
              releaseHeldItem();
            }
            config.onConnect();
          }
        },
        onRelease: () => {
          cableObj.updateCableCurve();
        }
      });
    }

    // 10. RÁDIO RETRÔ / BOOMBOX (Com Alça Superior, Deck de Fita Cassete, Botões Giratórios e Aros Cromados!)
    const radioGroup = new THREE.Group();
    radioGroup.position.set(-54, 0, -18);
    radioGroup.rotation.y = 0.42;

    const radioBody = new THREE.Mesh(
      new THREE.BoxGeometry(11.6, 5.8, 4.2),
      new THREE.MeshStandardMaterial({ color: 0xc03228, roughness: 0.32 })
    );
    radioBody.position.y = 2.9; radioBody.castShadow = true; radioGroup.add(radioBody);

    // Alça Superior Dobrável Preta e Cromada do Boombox
    const handlePostL = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.2, 0.6), inoxMat);
    handlePostL.position.set(-4.2, 6.2, 0);
    const handlePostR = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.2, 0.6), inoxMat);
    handlePostR.position.set(4.2, 6.2, 0);
    const handleBar = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.45, 0.7), new THREE.MeshStandardMaterial({ color: 0x16181c }));
    handleBar.position.set(0, 6.75, 0);
    radioGroup.add(handlePostL, handlePostR, handleBar);

    // Alto-falantes duplos com Aros Cromados + Cones Centrais
    const spkMat = new THREE.MeshStandardMaterial({ color: 0x181a1e, roughness: 0.65 });
    [-3.3, 3.3].forEach((sx) => {
      const spk = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 0.3, 28), spkMat);
      spk.rotation.x = Math.PI / 2; spk.position.set(sx, 2.5, 2.05);
      const chromeRing = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.12, 12, 28), inoxMat);
      chromeRing.position.set(sx, 2.5, 2.18);
      const dustCap = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), inoxMat);
      dustCap.scale.set(1, 1, 0.4);
      dustCap.position.set(sx, 2.5, 2.16);
      radioGroup.add(spk, chromeRing, dustCap);
    });

    // Deck Central de Fita Cassete + Knobs Cromados de Volume e Sintonia
    const tapeDeck = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.5, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.2 })
    );
    tapeDeck.position.set(0, 2.2, 2.08);
    [-1.6, 1.6].forEach((kx) => {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.35, 18), inoxMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(kx, 4.6, 2.16);
      radioGroup.add(knob);
    });
    radioGroup.add(tapeDeck);

    // Visor de frequência iluminado + Ponteiro Vermelho + Antena cromada
    const tuner = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.05), new THREE.MeshBasicMaterial({ color: 0xfff088 }));
    tuner.position.set(0, 4.6, 2.12);
    const tunerNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.05), new THREE.MeshBasicMaterial({ color: 0xff1744 }));
    tunerNeedle.position.set(0.45, 4.6, 2.15);
    radioGroup.add(tuner, tunerNeedle);

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 8.5, 10), inoxMat);
    antenna.position.set(-4.2, 8.8, -1.2); antenna.rotation.z = -0.25;
    radioGroup.add(antenna);

    deskWorld.add(radioGroup);
    // Rádio é o item central de uma "ilha" da mesa: fixo, mas interativo (toca as músicas do canal)
    const radioObs = { x: -54, z: -18, r: 5.2, box: { hx: 5.9, hz: 2.3 }, boxRot: 0.42, name: 'RÁDIO RETRÔ BOOMBOX FM 📻', isStatic: true };
    obstacles.push(radioObs);
    const radioParts = { tunerNeedle, antenna };

    // 11. PILHAS PALITO TURBO POSICIONADAS AO LONGO DA PISTA DE CORRIDA (MINI-TURBO BOOST AO PASSAR POR CIMA!)
    // Coordenadas exatas distribuídas ao longo das retas e curvas do circuito da pista de corrida!
    const turboBatteries = [];
    // Pilhas distribuídas sobre o circuito (4 na mesa e 4 embaixo dela): [x, z, rotY, y, nível]
    // Pilhas na pista (deslocadas para as bordas e giradas) + pilhas escondidas fora da pista
    const trackBatteryCoords = [
      // [x, z, nível, deslocamento lateral, giro extra]
      [30, 46, 'desk', 2.6, 0.5], [66, -20, 'desk', -2.4, 1.1], [20, -42, 'desk', 2.2, -0.4], [-79, -28, 'desk', -2.0, 0.9],
      [-110, -38, 'floor', 2.5, -0.7], [53, 8, 'floor', -2.6, 0.6], [-36, 33, 'floor', 2.4, 1.3], [-112, 58, 'floor', -2.2, -1.0]
    ].map(([x, z, level, off, rot]) => {
      const f = trackFrameAt(nearestTrackSample(x, z, level));
      return [f.s.x + f.nx * off, f.s.z + f.nz * off, Math.atan2(-f.tz, f.tx) + rot, f.s.y, level];
    }).concat([
      // Escondidas: atrás do aquário, canto da luminária, ao lado do pódio (mesa)
      [86, -14, 0.8, 0.165, 'desk'], [-76, -50, -0.6, 0.165, 'desk'], [-1, 51, 1.6, 0.165, 'desk'],
      // Saída do atalho (no chão, logo depois da rampa), atrás da estante, área livre do quarto (chão) e atrás do posto (chão)
      [4.5, 9, 0.2, -35.84, 'floor'], [88, -58, 2.4, -35.84, 'floor'],
      [-105, -30, 0.5, -35.84, 'floor'], [-138, 86, 0.9, -35.84, 'floor']
    ]);

    // Tipos de pilha: fraca/usada (cinza), semi-nova (laranja), nova (preta e cobre, rara e escondida)
    // e turbo dourada (super rara e escondida: leva a bateria a 120% sem nunca explodir)
    const BATTERY_TYPES = {
      weak: { label: 'Pilha fraca', min: 5, max: 15, body: 0x80848b, cap: 0xa9adb4, ring: 0xa0a6ad, rough: 0.75, metal: 0.05 },
      semi: { label: 'Pilha semi-nova', min: 20, max: 60, body: 0xff7a1a, cap: 0x2a2c31, ring: 0xffa94d, rough: 0.35, metal: 0.2 },
      fresh: { label: 'Pilha nova', min: 80, max: 100, body: 0x16181c, cap: 0xd9822b, ring: 0x00e5ff, rough: 0.25, metal: 0.3 },
      gold: { label: 'Pilha turbo dourada', gold: true, body: 0xffc93c, cap: 0xfff4c9, ring: 0xffd700, rough: 0.18, metal: 0.85 }
    };
    // Mesma ordem de trackBatteryCoords: 8 na pista (alternando semi-nova/fraca) + 7 escondidas
    const BATTERY_LAYOUT = ['semi', 'weak', 'semi', 'weak', 'semi', 'weak', 'semi', 'weak',
      'fresh', 'gold', 'fresh', 'fresh', 'gold', 'fresh', 'fresh'];
    const BATTERY_RESPAWN_S = 180; // pilha usada volta depois de 3 minutos

    trackBatteryCoords.forEach(([bx, bz, brot, by, blevel], idx) => {
      const type = BATTERY_TYPES[BATTERY_LAYOUT[idx] || 'semi'];
      const bat = new THREE.Group();
      bat.position.set(bx, by + 0.27, bz);
      bat.rotation.y = brot;

      // Corpo + topo colorido conforme o tipo + polo positivo cromado
      const bodyMat = new THREE.MeshStandardMaterial({ color: type.body, roughness: type.rough, metalness: type.metal });
      const capMat = new THREE.MeshStandardMaterial({ color: type.cap, metalness: type.gold ? 0.6 : 0.75, roughness: 0.2 });
      if (type.gold) { bodyMat.emissive = new THREE.Color(0xff9d00); bodyMat.emissiveIntensity = 0.35; }
      const bBody = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.65, 20), bodyMat);
      bBody.rotation.z = Math.PI / 2;
      bBody.castShadow = true;
      const bCap = new THREE.Mesh(new THREE.CylinderGeometry(0.425, 0.425, 0.82, 20), capMat);
      bCap.rotation.z = Math.PI / 2; bCap.position.x = 0.95;
      const bTip = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.24, 14), inoxMat);
      bTip.rotation.z = Math.PI / 2; bTip.position.x = 1.42;
      bat.add(bBody, bCap, bTip);
      // Pilha fraca fica levemente torta (cara de usada); dourada ganha uma estrelinha girando em cima
      if (BATTERY_LAYOUT[idx] === 'weak') bBody.rotation.x = 0.05;
      let sparkle = null;
      if (type.gold) {
        sparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), new THREE.MeshBasicMaterial({ color: 0xfff3a0 }));
        sparkle.position.set(0.2, 1.1, 0);
        bat.add(sparkle);
      }

      // Anel luminoso no chão sob a pilha (cor do tipo)
      const ringMat = new THREE.MeshBasicMaterial({ color: type.ring, transparent: true, opacity: type.gold ? 0.9 : 0.72, side: THREE.DoubleSide });
      const turboRing = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.85, 24), ringMat);
      turboRing.rotation.x = -Math.PI / 2;
      turboRing.position.set(0.2, -0.24, 0);
      bat.add(turboRing);

      deskWorld.add(bat);
      turboBatteries.push({
        id: 'bat_' + idx,
        kind: BATTERY_LAYOUT[idx] || 'semi',
        type,
        x: bx, z: bz, y: by, level: blevel,
        group: bat,
        ring: turboRing,
        sparkle,
        bolt: null,
        usedAt: -1,
        respawnAt: 0,
        lastBoostTime: -10
      });
    });

    // As pilhas palito agora aparecem uma única vez na cena (coerente com a conquista de 15 pilhas)
    function updateBatteryRespawns(time) {
      turboBatteries.forEach((tb) => {
        if (tb.collected) return;
        if (tb.sparkle) { tb.sparkle.rotation.y = time * 3; tb.sparkle.position.y = 1.1 + Math.sin(time * 4) * 0.15; }
        if (tb.respawnAt && time >= tb.respawnAt) {
          tb.respawnAt = 0;
          tb.group.visible = true;
          tb.popT = 0;
          if (tb.bolt) tb.bolt.visible = true;
          const d = Math.hypot(vehicle.position.x - tb.x, vehicle.position.z - tb.z);
          if (d < 40 && !sfx('sparkle', { vol: 0.35 })) playTone(784, 0, 0.08, 'triangle', 0.03);
        }
        if (tb.popT !== undefined && tb.popT < 1) {
          tb.popT = Math.min(1, tb.popT + 0.04);
          const s = tb.popT < 0.7 ? tb.popT / 0.7 * 1.2 : 1.2 - (tb.popT - 0.7) / 0.3 * 0.2;
          tb.group.scale.setScalar(Math.max(0.01, s));
        }
      });
    }
    function respawnAllBatteries(forceReset = false) {
      turboBatteries.forEach((tb) => {
        if (!forceReset && tb.collected) return;
        tb.collected = false;
        tb.respawnAt = 0;
        tb.group.visible = true;
        tb.group.scale.setScalar(1);
        if (tb.bolt) tb.bolt.visible = true;
      });
    }

    function syncBatteriesWithSavedState() {
      const collected = (typeof achievementState !== 'undefined' && achievementState.sets && achievementState.sets.turbo) ? achievementState.sets.turbo : [];
      turboBatteries.forEach((tb) => {
        if (collected.includes(tb.id)) {
          tb.collected = true;
          tb.respawnAt = 0;
          tb.group.visible = false;
          if (tb.bolt) tb.bolt.visible = false;
        }
      });
    }

    // 12. CABOS USB ENROLADOS NA MESA
    function createCoiledUsbCable(x, z, colorHex) {
      const cableGroup = new THREE.Group();
      cableGroup.position.set(x, 0.18, z);
      const cMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5 });
      for (let i = 0; i < 3; i++) {
        const loop = new THREE.Mesh(new THREE.TorusGeometry(2.2 + i * 0.25, 0.14, 10, 32), cMat);
        loop.rotation.x = Math.PI / 2;
        loop.position.set((i - 1) * 0.2, i * 0.08, 0);
        loop.castShadow = true;
        cableGroup.add(loop);
      }
      // Pontas USB metálicas
      const usbPlug = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.55), new THREE.MeshStandardMaterial({ color: 0xcfd6de, metalness: 0.85 }));
      usbPlug.position.set(2.5, 0.1, 0.8);
      cableGroup.add(usbPlug);
      deskWorld.add(cableGroup);
      // Cabo enrolado é baixinho: o carrinho passa por cima (h pequeno), mas ainda dá para pegá-lo
      const usbObs = { x, z, r: 2.6, h: 0.1, name: 'CABO USB-C ENROLADO' };
      obstacles.push(usbObs);
      registerGrabbable({
        id: 'usb_' + x, name: 'Cabo USB-C Enrolado', group: cableGroup, obs: usbObs,
        initX: x, initY: 0.18, initZ: z, initRotY: 0, grabRadius: 5.5
      });
    }
    createCoiledUsbCable(-38, -2, 0x22252a);
    createCoiledUsbCable(42, 6, 0xe8eceb);

    // 13. CAIXINHAS DE GUARDAR CLIPS (COM CLIPS COLORIDOS DENTRO E ESPALHADOS!)
    const clipGeometry = new THREE.TorusGeometry(0.35, 0.05, 8, 16);
    const CLIP_COLORS = [0x00e5ff, 0xff4081, 0xffeb3b, 0x76ff03, 0xd0d7de];
    const clipMaterials = CLIP_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.6, roughness: 0.2 }));
    const CLIPS_PER_BOX = 100;
    const CLIPS_SHOWN_INSIDE = 24; // clipes visíveis na pilha (representam os 100)
    // Clipes caem da caixinha enquanto ela é arrastada (1 a 2 por trecho, até esvaziar os 100)
    function updateClipPile(cb) {
      const shown = Math.ceil((cb.count / CLIPS_PER_BOX) * CLIPS_SHOWN_INSIDE);
      cb.inside.forEach((c, i) => { c.visible = i < shown; });
    }
    function dropClipsWhileDragging(item) {
      const cb = item.clipBox;
      const gp = item.group.position;
      cb.travel += Math.hypot(gp.x - cb.lastX, gp.z - cb.lastZ);
      cb.lastX = gp.x; cb.lastZ = gp.z;
      if (cb.travel < 2.2 || cb.count <= 0) return;
      cb.travel = 0;
      const count = Math.min(cb.count, 1 + Math.round(Math.random()));
      for (let i = 0; i < count; i++) {
        const dropped = new THREE.Mesh(clipGeometry, clipMaterials[(cb.count + i) % clipMaterials.length]);
        dropped.scale.set(1.6, 0.7, 1);
        dropped.rotation.set(Math.PI / 2, 0, Math.random() * Math.PI);
        dropped.position.set(gp.x + (Math.random() - 0.5) * 1.6, surfaceBaseY(gp.y) + 0.08, gp.z + (Math.random() - 0.5) * 1.6);
        (gp.y > -15 ? deskWorld : bedroomWorld).add(dropped);
        cb.dropped.push(dropped);
      }
      cb.count -= count;
      updateClipPile(cb);
      if (cb.count === 0) {
        showCarSpeech('A caixinha esvaziou!', 1800);
        logInteractionEvent('📎 Os 100 clipes caíram da caixinha!');
      } else if (cb.count % 25 === 0 || cb.count % 25 === 1) {
        setStatusBanner(`📎 Caixinha de clipes: ${cb.count} restantes`);
      }
    }
    function resetClipBox(item) {
      const cb = item.clipBox;
      cb.count = CLIPS_PER_BOX;
      if (item.obs && item.obs.burstBox) item.obs.burstBox.empty = false;
      cb.dropped.forEach(c => { if (c.parent) c.parent.remove(c); });
      cb.dropped.length = 0;
      cb.travel = 0;
      cb.lastX = item.initX; cb.lastZ = item.initZ;
      updateClipPile(cb);
    }

    function createClipBox(x, z, floor = false) {
      const cbGroup = new THREE.Group();
      cbGroup.position.set(x, floor ? FLOOR_SURFACE_Y : 0, z);

      const boxBase = new THREE.Mesh(
        new THREE.BoxGeometry(3.6, 1.4, 3.6),
        new THREE.MeshStandardMaterial({ color: 0x22262c, transparent: true, opacity: 0.75, roughness: 0.2 })
      );
      boxBase.position.y = 0.7; boxBase.castShadow = true;
      cbGroup.add(boxBase);

      // Borda magnética branca superior
      const magRim = new THREE.Mesh(
        new THREE.BoxGeometry(3.7, 0.25, 3.7),
        new THREE.MeshStandardMaterial({ color: 0xf0f4f8 })
      );
      magRim.position.y = 1.4;
      cbGroup.add(magRim);

      // Pilha de clipes coloridos (100 clipes por caixa, representados pela pilha visível)
      const insideClips = [];
      for (let i = 0; i < CLIPS_SHOWN_INSIDE; i++) {
        const clip = new THREE.Mesh(clipGeometry, clipMaterials[i % clipMaterials.length]);
        clip.scale.set(1.6, 0.7, 1);
        clip.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.4;
        clip.rotation.z = Math.random() * Math.PI;
        clip.position.set((Math.random() - 0.5) * 2.4, 0.4 + (i / CLIPS_SHOWN_INSIDE) * 1.2, (Math.random() - 0.5) * 2.4);
        cbGroup.add(clip);
        insideClips.push(clip);
      }

      (floor ? bedroomWorld : deskWorld).add(cbGroup);
      // Agora é um objeto com física: empurrável, tomba e, numa batida forte, abre e espalha os clipes
      const clipObs = registerDynamicObstacle({
        obs: { x, z, r: 2.4, box: { hx: 1.85, hz: 1.85 }, h: 1.6, name: 'CAIXINHA ORGANIZADORA DE CLIPS 📎' },
        group: cbGroup, mass: 0.9, canTopple: true
      });
      const item = registerGrabbable({
        id: 'clipbox_' + x + '_' + z, name: 'Caixinha de Clips (100)', group: cbGroup, obs: clipObs,
        initX: x, initY: cbGroup.position.y, initZ: z, initRotY: 0, grabRadius: 5.5,
        clipBox: { inside: insideClips, dropped: [], travel: 0, lastX: x, lastZ: z, count: CLIPS_PER_BOX }
      });
      clipObs.burstBox = { kind: 'clip', item, empty: false };
    }
    createClipBox(-16, 24);
    createClipBox(32, -5);
    createClipBox(44, -18);
    createClipBox(-30, 4);
    createClipBox(-8, -28);
    createClipBox(-30, -60, true);
    createClipBox(80, -40, true);

    // 14. CANETAS, PAPÉIS A4 E BLOCOS DE NOTAS ESPALHADOS PELA MESA
    function createNotepadAndPens(x, z, rotY) {
      const npGroup = new THREE.Group();
      npGroup.position.set(x, 0, z);
      npGroup.rotation.y = rotY;

      // Bloco de notas amarelo pautado
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(7.5, 0.28, 9.8),
        new THREE.MeshStandardMaterial({ color: 0xfff3a1, roughness: 0.8 })
      );
      pad.position.y = 0.14; pad.receiveShadow = true;
      npGroup.add(pad);

      // Cabeçalho vermelho do bloco
      const padTop = new THREE.Mesh(
        new THREE.BoxGeometry(7.55, 0.32, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x8c2318 })
      );
      padTop.position.set(0, 0.16, -4.35);
      npGroup.add(padTop);

      // Folha A4 branca solta ao lado
      const sheet = new THREE.Mesh(
        new THREE.BoxGeometry(7.2, 0.06, 9.5),
        new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7 })
      );
      sheet.position.set(6.8, 0.04, 1.2);
      sheet.rotation.y = 0.28;
      sheet.receiveShadow = true;
      npGroup.add(sheet);

      // Canetas esferográficas (Azul e Vermelha)
      [
        { px: 1.5, pz: 0.5, rot: 0.45, col: 0x1565c0 },
        { px: 5.8, pz: -1.0, rot: -0.3, col: 0xd32f2f }
      ].forEach((p) => {
        const pen = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.14, 5.2, 12),
          new THREE.MeshStandardMaterial({ color: p.col, roughness: 0.25 })
        );
        pen.rotation.x = Math.PI / 2;
        pen.rotation.z = p.rot;
        pen.position.set(p.px, 0.35, p.pz);
        pen.castShadow = true;
        npGroup.add(pen);
      });

      deskWorld.add(npGroup);
      notepadRefs.push({ pad, sheet, group: npGroup });
    }
    const notepadRefs = []; // cadernos que exibem conquistas e recordes (ver drawNotebooks)
    createNotepadAndPens(-52, 16, 0.18);
    createNotepadAndPens(14, 30, -0.22);

    // Post-its coloridos
    [0xffeb3b, 0xff4081, 0x00e5ff].forEach((col, i) => {
      const postIt = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.18, 2.4),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 })
      );
      postIt.position.set(-10 + i * 3.0, 0.09, 13.5 + (i % 2) * 0.6);
      postIt.rotation.y = (i - 1) * 0.18;
      postIt.receiveShadow = true;
      deskWorld.add(postIt);
    });


    // ============================================================================
    // BIBLIOTECA DE MODELOS 3D GLB (PASTA /models)
    // Os GLBs baixados não trazem materiais nem texturas: cada modelo recebe uma
    // pintura procedural por face (cores flat estilo Bruno Simon), é encaixado pelo
    // bounding box real (sem escalas "mágicas"), tem o pivô na base (tomba e gira
    // corretamente) e ganha colisor com raio/altura derivados das dimensões.
    // ============================================================================
    const gltfLoader = new THREE.GLTFLoader();
    const loaded3DModels = [];
    const glbPrototypeCache = new Map();
    const floatingProps = [];   // raios turbo e marcadores animados
    const band = (v, a, b) => v >= a && v <= b;

    // Altura do topo da mesa no ponto (o deskmat de feltro tem 0.14 de espessura)
    function deskY(x, z) {
      return (x > -26 && x < 42 && z > -11 && z < 23) ? 0.14 : 0.0;
    }

    // paint(p, n, opts): p = centróide da face normalizado no bbox [0..1] (+ rxz / rxy radiais), n = normal da face
    const MODEL_LIBRARY = {
      traffic_cone_01: {
        name: 'Cone de Trânsito', fit: { height: 3.0 }, mass: 0.35, roughness: 0.55,
        paint: (p) => p.y < 0.1 ? 0x2b2b30 : (band(p.y, 0.36, 0.48) || band(p.y, 0.6, 0.7)) ? 0xf4f4ef : 0xff6a1a
      },
      traffic_cone_02: {
        name: 'Cone Listrado', fit: { height: 3.0 }, mass: 0.35, roughness: 0.55,
        paint: (p) => (band(p.y, 0.3, 0.42) || band(p.y, 0.56, 0.68)) ? 0xf4f4ef : p.y < 0.06 ? 0xd94a14 : 0xff6a1a
      },
      apple: {
        name: 'Maçã Vermelha', fit: { height: 3.2 }, mass: 0.45, roughness: 0.32,
        paint: (p) => p.y > 0.88 ? (p.rxz < 0.16 ? 0x6b4423 : 0x5aa832) : p.y < 0.08 ? 0x9e1b1f : 0xd8282a
      },
      banana: {
        name: 'Banana', fit: { length: 7.6 }, mass: 0.4, roughness: 0.5,
        paint: (p) => (p.z < 0.05 || p.z > 0.95) ? 0x4a3418 : 0xf3d13a
      },
      cheeseburger: {
        name: 'Cheeseburger', fit: { length: 4.8 }, mass: 0.6, roughness: 0.65,
        paint: (p) => p.y < 0.2 ? 0xd18f45 : p.y < 0.4 ? 0x5a321f : p.y < 0.5 ? 0xffc23d : p.y < 0.58 ? 0x6cc04a : p.y < 0.64 ? 0xe2412f : 0xe0a050
      },
      rocket_toy_01: {
        name: 'Foguete de Brinquedo', fit: { height: 4.2 }, mass: 0.6, roughness: 0.4,
        paint: (p, n) => p.y > 0.74 ? 0xe63946 : (p.rxz > 0.62 && p.y < 0.4) ? 0xe63946 : p.y < 0.05 ? 0x3b3f46 : (band(p.y, 0.5, 0.62) && n.z > 0.55) ? 0x5fc8ff : 0xf3f3f3
      },
      water_pistol: {
        name: "Pistola d'Água", fit: { length: 4.6 }, mass: 0.6, roughness: 0.3,
        paint: (p) => p.y > 0.72 ? 0xffb703 : p.z > 0.88 ? 0xffd23f : (p.y < 0.5 && p.z < 0.5) ? 0x1d4ed8 : 0x3b82f6
      },
      stapler: {
        name: 'Grampeador', fit: { length: 4.6 }, mass: 0.9, roughness: 0.35, metalness: 0.2,
        paint: (p) => p.y > 0.55 ? 0xc1121f : band(p.y, 0.42, 0.55) ? 0xc9ced6 : 0x22252b
      },
      storage_box_01: {
        name: 'Caixa Organizadora', fit: { length: 5.2 }, mass: 1.0, roughness: 0.45,
        paint: (p) => p.y > 0.86 ? 0xf1f1ef : 0x4cc9f0
      },
      acoustic_guitar: {
        name: 'Violão Acústico', fit: { height: 26 }, mass: 2.5, roughness: 0.4,
        paint: (p, n) => {
          if (p.y > 0.86) return 0x3b2414;                                   // mão / tarraxas
          if (p.y > 0.5 && band(p.x, 0.38, 0.62)) return 0x5a3a22;           // braço
          if (n.z > 0.6 && Math.hypot((p.x - 0.5) * 0.383, p.y - 0.37) < 0.04) return 0x1b120c; // boca
          return n.z > 0.6 ? 0xc48a4e : 0x8a5226;                            // tampo / laterais
        }
      },
      desk_lamp: {
        name: 'Luminária de Mesa', fit: { height: 13 }, mass: 1.6, roughness: 0.4, metalness: 0.3,
        paint: (p, n) => p.y < 0.1 ? 0x1f2a36 : (n.y < -0.6 && p.y > 0.55) ? 0xfff3c4 : 0x2a9d8f
      },
      mesh_bin: {
        name: 'Cesto de Metal', fit: { height: 9.6 }, mass: 1.2, roughness: 0.4, metalness: 0.55, doubleSide: true,
        paint: (p) => p.y > 0.95 ? 0x3d4148 : 0x24272c
      },
      computer_headphones_01: {
        name: 'Headphone', fit: { length: 6.5 }, mass: 0.7, roughness: 0.45,
        paint: (p, n) => {
          if (p.y > 0.9) return 0xc21515;                                     // almofada da haste (crimson do DS)
          if (p.y < 0.45 && ((p.x < 0.22 && n.x > 0.4) || (p.x > 0.78 && n.x < -0.4))) return 0x3a3d44; // espumas
          return p.y < 0.45 ? 0x1b1d22 : 0x2b2e35;
        }
      },
      fire_alarm_bell: {
        name: 'Alarme de Incêndio', fit: { max: 6 }, rot: [Math.PI / 2, 0, 0], roughness: 0.35, metalness: 0.25, noAO: true,
        paint: (p) => p.z < 0.22 ? 0x8f1414 : p.rxy < 0.12 ? 0xc9ced6 : 0xd62828
      },
      light_switch_01: {
        name: 'Interruptor', fit: { max: 3.2 }, roughness: 0.3, noAO: true,
        paint: (p) => (p.rxy < 0.28 && p.z > 0.5) ? 0xe2e5e9 : 0xfafafa
      },
      flower_pot_01: {
        name: 'Vaso de Barro', fit: { height: 9 }, mass: 2.5, roughness: 0.85,
        paint: (p, n) => (n.y > 0.8 && p.y > 0.6 && p.rxz < 0.8) ? 0x4b3621 : p.y > 0.85 ? 0xb4472f : 0xc8553d
      },
      paper_bag_01: {
        name: 'Sacola de Papel', fit: { height: 9 }, mass: 0.5, roughness: 0.9,
        paint: (p) => p.y > 0.9 ? 0xb08a55 : 0xc9a46b
      },
      lightning_bolt: {
        name: 'Raio Turbo', fit: { height: 1.8 }, roughness: 0.3, emissive: 0xffd60a, emissiveIntensity: 0.55, castShadow: false, noAO: true,
        paint: () => 0xffe14d
      },
      location_marker: {
        name: 'Marcador', fit: { height: 2.6 }, roughness: 0.35, emissive: 0xffceca, emissiveIntensity: 0.18, castShadow: false, noAO: true,
        paint: (p) => p.y < 0.32 ? 0xc21515 : 0xffceca
      },
      sticky_note_pad: {
        name: 'Bloco de Post-it', fit: { length: 3.2 }, roughness: 0.8, noAO: true,
        paint: (p) => p.y > 0.85 ? 0xffe066 : 0xf9d342
      },
      sticky_note: {
        name: 'Post-it', fit: { length: 3.0 }, roughness: 0.8, noAO: true,
        paint: (p, n, o) => o.tint || 0xff8fab
      },
      finger_post_sign_01: {
        name: 'Placa de Direção', fit: { height: 11 }, roughness: 0.75,
        paint: (p) => p.y > 0.55 ? 0xd9a066 : 0x8a5a2b
      },
      arrow_01: {
        name: 'Seta', fit: { max: 5 }, rot: [-Math.PI / 2, 0, 0], roughness: 0.5, emissive: 0xffceca, emissiveIntensity: 0.12, castShadow: false, noAO: true,
        paint: () => 0xffceca
      },
      pacifier_01: {
        name: 'Chupeta do Ravi', fit: { max: 1.8 }, mass: 0.2, roughness: 0.35,
        paint: (p) => p.z > 0.7 ? 0xfefae0 : p.z < 0.3 ? 0xffb703 : 0x8ecae6
      },
      jigsaw_piece: {
        name: 'Peça de Quebra-Cabeça', fit: { length: 2.4 }, roughness: 0.6, noAO: true,
        paint: (p, n, o) => o.tint || 0x2a9d8f
      },
      brick_flemish_bond: {
        name: 'Bloco de Tijolos', fit: { length: 9 }, mass: 3.0, roughness: 0.9,
        paint: (p, n) => n.y > 0.9 ? 0xa6472f : 0xb5523b
      },
      hand_strengthener: {
        name: 'Hand Grip', fit: { length: 3.6 }, rot: [-Math.PI / 2, 0, 0], mass: 0.4, roughness: 0.45,
        paint: (p) => p.z > 0.65 ? 0x22252b : p.z < 0.3 ? 0xff6b35 : 0xc9ced6
      },
      guitar_wall_hanger_02: {
        name: 'Suporte de Violão', fit: { max: 2.6 }, roughness: 0.35, metalness: 0.4,
        paint: () => 0x2b2e35
      },
      crystal: {
        name: 'Cristal', fit: { height: 2.4 }, mass: 0.3, roughness: 0.15, emissive: 0x7b2ff7, emissiveIntensity: 0.25, noAO: true,
        paint: () => 0xb388ff
      },
      health_pickup: {
        name: 'Kit de Primeiros Socorros', fit: { max: 2.6 }, mass: 0.4, roughness: 0.4, noAO: true,
        paint: (p, n) => n.z > 0.8 ? 0xe63946 : 0xf1f1f1
      },
      speech_bubble_01: {
        name: 'Balão de Fala', fit: { max: 3.2 }, mass: 0.3, roughness: 0.5, noAO: true,
        paint: (p, n) => Math.abs(n.z) > 0.8 ? 0xffffff : 0xffceca
      },
      speech_bubble_02: {
        name: 'Balão de Pensamento', fit: { max: 3.2 }, mass: 0.3, roughness: 0.5, noAO: true,
        paint: (p, n) => Math.abs(n.z) > 0.8 ? 0xffffff : 0x251f2b
      },
      mug: {
        name: 'Caneca de Café', fit: { height: 2.4 }, mass: 0.5, roughness: 0.3,
        paint: (p, n) => (n.y > 0.8 && p.y > 0.8 && p.rxz < 0.7) ? 0x4a2c17 : 0xe76f51
      },
      pencil_01: {
        name: 'Lápis', fit: { length: 4.4 }, mass: 0.15, roughness: 0.5,
        paint: (p) => p.z > 0.92 ? 0x2b2b2b : p.z > 0.82 ? 0xe9c39b : p.z < 0.08 ? 0xff8fab : p.z < 0.14 ? 0xc9ced6 : 0xffc300
      },
      paperclip: {
        name: 'Clipe', fit: { length: 1.6 }, mass: 0.05, roughness: 0.25, metalness: 0.8, noAO: true,
        paint: () => 0xc9ced6
      },
      computer_screen_01: {
        name: 'Monitor Retrô', fit: { length: 9 }, mass: 2.0, roughness: 0.4,
        paint: (p, n) => (n.z > 0.8 && p.y > 0.3 && band(p.x, 0.04, 0.96)) ? 0x0b0f14 : 0x2b2e35
      }
    };

    // Pinta cada triângulo com a cor da regra + leve oclusão de contato na base
    function paintGeometry(geo, spec, box, size, opts) {
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const col = new THREE.Color();
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
      const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
      const halfXZ = Math.max(size.x, size.z) / 2 || 1;
      const halfXY = Math.max(size.x, size.y) / 2 || 1;
      const p = {};
      for (let i = 0; i + 2 < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        const mx = (a.x + b.x + c.x) / 3, my = (a.y + b.y + c.y) / 3, mz = (a.z + b.z + c.z) / 3;
        n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        if (n.lengthSq() < 1e-14) n.set(0, 1, 0); else n.normalize();
        p.x = size.x ? (mx - box.min.x) / size.x : 0.5;
        p.y = size.y ? (my - box.min.y) / size.y : 0.5;
        p.z = size.z ? (mz - box.min.z) / size.z : 0.5;
        p.rxz = Math.hypot(mx - cx, mz - cz) / halfXZ;
        p.rxy = Math.hypot(mx - cx, my - cy) / halfXY;
        // Cor em sRGB convertida para linear: o tom final na tela fica igual ao planejado (antes clareava/lavava)
        col.setHex(spec.paint(p, n, opts || {})).convertSRGBToLinear();
        if (!spec.noAO) col.multiplyScalar(0.8 + 0.2 * THREE.MathUtils.smoothstep(p.y, 0, 0.22));
        for (let k = 0; k < 3; k++) {
          colors[(i + k) * 3] = col.r; colors[(i + k) * 3 + 1] = col.g; colors[(i + k) * 3 + 2] = col.b;
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    // Carrega (uma vez por modelo/tinta) e prepara o protótipo encaixado e pintado
    function buildModelPrototype(key, opts = {}) {
      const cacheKey = key + '|' + (opts.tint || '');
      if (glbPrototypeCache.has(cacheKey)) return glbPrototypeCache.get(cacheKey);
      const spec = MODEL_LIBRARY[key];
      const promise = new Promise((resolve, reject) => {
        if (!spec) { reject(new Error('Modelo desconhecido: ' + key)); return; }
        gltfLoader.load(`./models/${key}/${key}.glb`, (gltf) => {
          const root = gltf.scene;
          root.updateMatrixWorld(true);
          const geos = [];
          root.traverse((o) => {
            if (!o.isMesh) return;
            let g = o.geometry.clone();
            g.applyMatrix4(o.matrixWorld);
            if (g.index) g = g.toNonIndexed();
            geos.push(g);
          });
          if (spec.rot) {
            const rm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...spec.rot));
            geos.forEach(g => g.applyMatrix4(rm));
          }
          const box = new THREE.Box3();
          geos.forEach((g) => { g.computeBoundingBox(); box.union(g.boundingBox); });
          const size = box.getSize(new THREE.Vector3());
          geos.forEach(g => paintGeometry(g, spec, box, size, opts));

          // Encaixe pelo bbox real + pivô no centro da base
          const fit = spec.fit || { max: 3 };
          const measured = fit.height ? size.y : fit.length ? Math.max(size.x, size.z) : Math.max(size.x, size.y, size.z);
          const wanted = fit.height || fit.length || fit.max;
          const s = wanted / (measured || 1);
          const fitMatrix = new THREE.Matrix4().makeScale(s, s, s).multiply(
            new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
          );

          const mat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: spec.roughness !== undefined ? spec.roughness : 0.6,
            metalness: spec.metalness || 0,
            envMap: envMapTexture,
            envMapIntensity: spec.envIntensity !== undefined ? spec.envIntensity : 0.45,
            side: spec.doubleSide ? THREE.DoubleSide : THREE.FrontSide
          });
          if (spec.emissive) {
            mat.emissive = new THREE.Color(spec.emissive);
            mat.emissiveIntensity = spec.emissiveIntensity || 0.3;
          }

          const proto = new THREE.Group();
          geos.forEach((g) => {
            g.applyMatrix4(fitMatrix);
            g.computeBoundingBox();
            g.computeBoundingSphere();
            const m = new THREE.Mesh(g, mat);
            m.castShadow = spec.castShadow !== false;
            m.receiveShadow = true;
            proto.add(m);
          });
          proto.userData.dims = { w: size.x * s, h: size.y * s, d: size.z * s };
          resolve(proto);
        }, undefined, reject);
      });
      glbPrototypeCache.set(cacheKey, promise);
      return promise;
    }

    // Instancia um modelo da biblioteca na cena, com física e "pegar" opcionais
    function placeModel(key, opts = {}) {
      const spec = MODEL_LIBRARY[key];
      if (IS_QUINTAL && (opts.parent || (opts.x || 0) < QUINTAL_MIN_X)) return Promise.resolve(null); // quintal: sem modelos da casa
      return buildModelPrototype(key, opts).then((proto) => {
        const container = new THREE.Group(); // pivô na base: tombamento natural
        const inner = proto.clone();
        const k = opts.scale || 1;
        inner.scale.setScalar(k);
        if (opts.innerRot) inner.rotation.set(...opts.innerRot);
        container.add(inner);

        const x = opts.x || 0, z = opts.z || 0;
        const onFloor = opts.floor === true;
        let y = opts.y !== undefined ? opts.y : (onFloor ? FLOOR_SURFACE_Y : deskY(x, z));
        // Objetos no chão do quarto assentam na superfície real (gramado da ilha ou piso), sem flutuar
        if (!opts.parent && Math.abs(y - FLOOR_SURFACE_Y) < 0.7 && typeof floorExtraHeight === 'function') {
          try { y = FLOOR_SURFACE_Y + Math.max(0, floorExtraHeight(x, z)); } catch (e) { /* ilhas ainda não criadas */ }
        }
        container.position.set(x, y, z);
        container.rotation.y = opts.rotY || 0;
        container.name = opts.name || spec.name;
        container.userData.name = container.name;
        container.userData.modelKey = key;
        container.traverse((ch) => { if (ch.isMesh) ch.userData.parentGroup = container; });
        (opts.parent || (y < -15 ? bedroomWorld : deskWorld)).add(container);

        const dims = { w: proto.userData.dims.w * k, h: proto.userData.dims.h * k, d: proto.userData.dims.d * k };
        container.userData.dims = dims;

        if (opts.physics !== false) {
          const r = opts.r !== undefined ? opts.r : Math.max(0.6, Math.max(dims.w, dims.d) * 0.45);
          const obs = registerDynamicObstacle({
            obs: Object.assign({ x, z, r, h: dims.h, name: (opts.name || spec.name).toUpperCase() },
              spec.collider === 'circle' ? {} : { box: { hx: dims.w / 2, hz: dims.d / 2 } }),
            group: container,
            mass: opts.mass || spec.mass || 0.8,
            canTopple: opts.canTopple !== undefined ? opts.canTopple : true,
            isStatic: !!opts.isStatic
          });
          container.userData.obs = obs;
          if (!opts.isStatic && opts.grabbable !== false) {
            registerGrabbable({
              id: opts.id || ('glb_' + key + '_' + loaded3DModels.length),
              name: opts.name || spec.name,
              group: container,
              obs,
              initX: x, initY: y, initZ: z, initRotY: opts.rotY || 0,
              grabRadius: opts.grabRadius || Math.max(3.6, r + 2.6)
            });
          }
        }
        if (opts.breakable && container.userData.obs) setupBreakable(container.userData.obs, container, opts.breakable);
        // Fixos altos (estante, cômoda, piano, postes...) ficam transparentes se taparem o carrinho
        if (opts.occluder || (opts.isStatic && dims.h > 5)) registerOccluderTree(container);
        loaded3DModels.push({ model: container, key, opts });
        if (opts.onLoad) opts.onLoad(container);
        return container;
      }).catch((err) => {
        console.warn('Aviso: modelo 3D não carregado:', key, err);
        return null;
      });
    }

    // --- MESA: brinquedos, lanches e acessórios empurráveis (fora do traçado do circuito) ---
    placeModel('traffic_cone_01', { x: -32, z: 15, name: 'Cone de Trânsito 1' });
    placeModel('traffic_cone_02', { x: -48, z: 18, name: 'Cone Listrado 2' });
    placeModel('water_pistol', { x: -38, z: -4, rotY: 0.45, name: "Pistola d'Água (reservatório extra +100%)", id: 'water_pistol' });
    placeModel('cheeseburger', { x: 34, z: -3.5, name: 'Cheeseburger', breakable: 'food' });
    placeModel('apple', { x: 41, z: -6.5, name: 'Maçã Vermelha', breakable: 'food' });
    placeModel('banana', { x: 32, z: 7, rotY: 1.5, name: 'Banana', breakable: 'food' });
    placeModel('stapler', { x: -42, z: 28, rotY: -0.35, name: 'Grampeador Metálico' });
    // Caixinhas azuis de post-its: tampa branca solta; numa batida forte a tampa voa e ~50 post-its se espalham
    function setupNoteBox(box) {
      const o = box.userData.obs;
      if (!o) return;
      const d = box.userData.dims;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(d.w * 1.04, 0.3, d.d * 1.04), new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.5 }));
      lid.position.y = d.h + 0.12;
      lid.castShadow = true;
      box.add(lid);
      o.mass = 0.9;
      o.burstBox = { kind: 'postit', lid, dims: d, empty: false };
    }
    [[34, 28, 0.2], [-20, -30, -0.4], [20, -26, 0.7], [-70, 30, 1.2]].forEach(([x, z, r], i) => {
      placeModel('storage_box_01', { x, z, rotY: r, name: 'Caixinha de Post-its', id: 'notebox_' + i, onLoad: setupNoteBox });
    });
    placeModel('storage_box_01', { x: -60, z: -60, floor: true, rotY: 0.5, name: 'Caixinha de Post-its', id: 'notebox_floor', onLoad: setupNoteBox });
    placeModel('computer_headphones_01', { x: 80, z: -47, rotY: -0.4, name: 'Headphone' });
    placeModel('hand_strengthener', { x: 82, z: 47, rotY: 0.7, name: 'Hand Grip' });
    placeModel('desk_lamp', {
      x: -84, z: -48, rotY: 0.7, isStatic: true, r: 2.6, name: 'Luminária de Mesa',
      onLoad: (lamp) => {
        const lampLight = new THREE.PointLight(0xffd9a0, 0.9, 38, 2);
        lampLight.position.set(0, lamp.userData.dims.h * 0.82, 2.2);
        lamp.add(lampLight);
      }
    });
    // Post-its e bloco (planos: o carrinho passa por cima)
    placeModel('sticky_note_pad', { x: -60, z: 32, rotY: 0.25, physics: false });
    placeModel('sticky_note', { x: -55.5, z: 28, rotY: -0.3, physics: false, tint: 0xff8fab });
    placeModel('sticky_note', { x: -64, z: 27, rotY: 0.5, physics: false, tint: 0x8ecae6 });

    // Raios turbo flutuando sobre cada pilha palito
    trackBatteryCoords.slice(0, 8).forEach(([bx, bz, , by]) => { // as escondidas não têm raio sinalizando
      placeModel('lightning_bolt', {
        x: bx, z: bz, y: by + 2.4, physics: false,
        onLoad: (bolt) => { const tb = turboBatteries.find(b => Math.hypot(b.x - bx, b.z - bz) < 0.01); if (tb) { tb.bolt = bolt; bolt.visible = tb.group.visible; } floatingProps.push({ obj: bolt, baseY: by + 2.4, spin: 1.6, bob: 0.25, phase: bx * 0.1 + bz * 0.07 }); }
      });
    });

    // Marcadores de interação (somem quando a missão é cumprida)
    const markerSpecs = [
      { x: -26, z: 14, y: 11.5, isActive: () => !cupSpilled },
      { x: -16, z: 36, y: 3.2, isActive: () => !(achievementState && achievementState.unlocked.artist) },
      ...growablePlantsMarkers()
    ];
    function growablePlantsMarkers() {
      return growablePlants.map(pl => ({ x: pl.x, z: pl.z, y: pl.onFloor ? -6 : 6.2, plant: pl, isActive: () => !pl.isWatered }));
    }
    markerSpecs.forEach((ms) => {
      placeModel('location_marker', {
        x: ms.x, z: ms.z, y: ms.y, physics: false,
        onLoad: (m) => floatingProps.push({ obj: m, baseY: ms.y, spin: 1.2, bob: 0.35, phase: ms.x, isActive: ms.isActive, follow: ms.plant })
      });
    });

    // --- QUARTO (chão y = -36): o restante dos objetos fica no bloco "ILHAS / MÓVEIS DO QUARTO" ---
    // Cesto de metal real no lugar do cilindro procedural
    placeModel('mesh_bin', {
      parent: trashBinGroup, x: 0, y: 0, z: 0, physics: false, name: 'Cesto de Metal',
      onLoad: () => { binMesh.visible = false; paperBall.position.y = 2.2; }
    });
    let fireBellModel = null;

    // Anima raios turbo e marcadores flutuantes
    function updateFloatingProps(time) {
      floatingProps.forEach((fp) => {
        const active = fp.isActive ? fp.isActive() : true;
        const targetScale = active ? 1 : 0;
        const sNow = fp.obj.scale.x + (targetScale - fp.obj.scale.x) * 0.12;
        fp.obj.scale.setScalar(sNow);
        fp.obj.visible = sNow > 0.02;
        if (!fp.obj.visible) return;
        if (fp.follow) { fp.obj.position.x = fp.follow.x; fp.obj.position.z = fp.follow.z; }
        fp.obj.position.y = fp.baseY + Math.sin(time * 2.2 + fp.phase) * fp.bob;
        fp.obj.rotation.y = time * fp.spin + fp.phase;
      });
      if (fireBellModel) {
        fireBellModel.rotation.z = monitorState === 'burning' ? Math.sin(time * 60) * 0.06 : 0;
      }
    }


    // ============================================================================
    // NOVOS MODELOS CC0 (thebasemesh.com) — móveis do quarto e cenários das ilhas
    // ============================================================================
    Object.assign(MODEL_LIBRARY, {
      office_chair: {
        name: 'Cadeira de Escritório', fit: { height: 26 }, mass: 4, roughness: 0.5,
        paint: (p) => p.y < 0.12 ? 0x2b2e35 : p.y < 0.42 ? 0x6c757d : 0x3a86ff
      },
      door_01: {
        name: 'Porta do Quarto', fit: { height: 52 }, roughness: 0.6, noAO: true,
        paint: (p, n) => (p.x > 0.84 && band(p.y, 0.46, 0.54) && Math.abs(n.z) < 0.99) ? 0xd4af37 : (Math.abs(n.z) > 0.8 ? 0xf2e3c6 : 0xc9a77c)
      },
      volleyball: {
        name: 'Bola do Ravi', fit: { max: 6 }, mass: 0.6, roughness: 0.45,
        paint: (p, n) => {
          const k = Math.floor((Math.atan2(n.z, n.x) + Math.PI) / (Math.PI / 3));
          return [0xffffff, 0xffc300, 0x3a86ff, 0xffffff, 0xffc300, 0x3a86ff][k % 6];
        }
      },
      bedside_table_01: {
        name: 'Criado-mudo', fit: { height: 16 }, roughness: 0.55,
        paint: (p, n) => n.z > 0.8 ? 0xf1e4cf : 0xc79a6b
      },
      chest_of_drawers_01: {
        name: 'Cômoda', fit: { height: 26 }, roughness: 0.55,
        paint: (p, n) => (n.z > 0.8 && p.y < 0.9) ? (Math.floor(p.y * 4) % 2 ? 0x8ecae6 : 0xffd6a5) : 0xf6f1e9
      },
      medieval_bookcase: {
        name: 'Estante', fit: { height: 37 }, roughness: 0.65,
        paint: (p, n) => n.z > 0.8 && p.z < 0.6 ? 0x6b4423 : 0xa0703c
      },
      retro_tv: {
        name: 'TV Retrô', fit: { height: 14 }, roughness: 0.4,
        paint: (p, n) => (n.z > 0.7 && p.x < 0.78 && p.y > 0.15 && p.y < 0.88) ? 0x1b2a41 : (p.x > 0.8 && n.z > 0.7) ? 0x2b2e35 : 0xe76f51
      },
      electric_guitar: {
        name: 'Guitarra', fit: { height: 18 }, roughness: 0.3,
        paint: (p, n) => p.y > 0.86 ? 0x22252b : p.y > 0.45 ? 0xd9a066 : (n.z > 0.6 ? 0xe63946 : 0xffffff)
      },
      guitar_stand: {
        name: 'Suporte de Guitarra', fit: { height: 7 }, roughness: 0.4, metalness: 0.4,
        paint: () => 0x2b2e35
      },
      piano: {
        name: 'Piano de Brinquedo', fit: { height: 13 }, roughness: 0.35,
        paint: (p, n) => (n.y > 0.8 && band(p.y, 0.45, 0.75) && p.z > 0.55) ? (Math.floor(p.x * 30) % 2 ? 0xffffff : 0x111111) : 0xc1121f
      },
      wooden_boat_01: {
        name: 'Barquinho', fit: { length: 13 }, roughness: 0.6,
        paint: (p, n) => n.y > 0.75 && p.y < 0.6 ? 0xe9c46a : p.y > 0.75 ? 0xe63946 : 0x8a5226
      },
      mushroom_01: { name: 'Cogumelo', fit: { height: 5 }, roughness: 0.5, paint: (p) => p.y > 0.55 ? ((Math.sin(p.x * 31) * Math.cos(p.z * 27) > 0.55) ? 0xffffff : 0xe63946) : 0xf6efe2 },
      mushroom_02: { name: 'Cogumelo Laranja', fit: { height: 4 }, roughness: 0.5, paint: (p) => p.y > 0.5 ? 0xff9f1c : 0xf6efe2 },
      mushroom_03: { name: 'Cogumelo Lilás', fit: { height: 5.5 }, roughness: 0.5, paint: (p) => p.y > 0.55 ? 0xb388ff : 0xf6efe2 },
      rock_01: { name: 'Pedra', fit: { length: 7 }, roughness: 0.9, paint: (p) => p.y > 0.7 ? 0xb8b8c0 : 0x8d8f99 },
      rock_02: { name: 'Pedra Grande', fit: { length: 8 }, roughness: 0.9, paint: (p) => p.y > 0.7 ? 0xb0aeb8 : 0x84828f },
      star_01: { name: 'Estrela', fit: { max: 5 }, rot: [Math.PI / 2, 0, 0], roughness: 0.3, emissive: 0xffd60a, emissiveIntensity: 0.5, noAO: true, castShadow: false, paint: () => 0xffe14d },
      crescent_moon: { name: 'Lua', fit: { max: 6 }, roughness: 0.3, emissive: 0xfff3c4, emissiveIntensity: 0.4, noAO: true, castShadow: false, paint: () => 0xfff3c4 },
      globe: { name: 'Globo Terrestre', fit: { height: 7 }, roughness: 0.4, paint: (p, n) => p.y < 0.18 ? 0x2b2e35 : (Math.sin(n.x * 6) * Math.cos(n.y * 5 + n.z * 4) > 0.2 ? 0x52b788 : 0x3a86ff) },
      d6_dice: { name: 'Dado Gigante', fit: { max: 3.2 }, mass: 1.0, roughness: 0.4, noAO: true, paint: (p, n, o) => (Math.abs(p.x - 0.5) < 0.12 && Math.abs(p.z - 0.5) < 0.12) || (Math.abs(p.y - 0.5) < 0.12 && Math.abs(p.x - 0.5) < 0.12) ? 0xffffff : (o.tint || 0xe63946) },
      rocket_toy_02: { name: 'Foguete Espacial', fit: { height: 12 }, roughness: 0.4, paint: (p, n) => p.y > 0.72 ? 0xe63946 : (p.rxz > 0.6 && p.y < 0.35) ? 0x3a86ff : (band(p.y, 0.48, 0.6) && n.z > 0.5) ? 0x5fc8ff : 0xf3f3f3 },
      wall_clock: { name: 'Relógio de Parede', fit: { max: 9 }, roughness: 0.4, noAO: true, paint: (p, n) => (n.z > 0.8 && p.rxy < 0.85) ? 0xffffff : 0xe63946 },
      painting_frame_01: { name: 'Moldura', fit: { max: 16 }, roughness: 0.5, noAO: true, paint: () => 0xc68b59 },
      cushion_01: { name: 'Almofada', fit: { length: 7 }, mass: 0.4, roughness: 0.9, paint: (p, n, o) => o.tint || 0xff8fab },
      skateboard_setup: { name: 'Skate', fit: { length: 9 }, mass: 0.8, roughness: 0.4, paint: (p) => p.y < 0.35 ? 0xffd166 : (p.y > 0.8 ? 0x22252b : 0x2a9d8f) },
      park_bench: { name: 'Banco do Parque', fit: { length: 13 }, roughness: 0.6, paint: (p) => p.y < 0.15 ? 0x2b2e35 : 0xb5651d },
      lamp_post_01: { name: 'Poste de Luz', fit: { height: 22 }, roughness: 0.4, metalness: 0.3, paint: (p, n) => (p.y > 0.86 && n.y < 0.2) ? 0xfff3c4 : 0x2b2e35 },
      japanese_stone_lantern_01: { name: 'Lanterna de Pedra', fit: { height: 8 }, roughness: 0.85, paint: (p, n) => band(p.y, 0.45, 0.62) && Math.abs(n.y) < 0.4 ? 0xffd166 : 0xa7a9b4 },
      rounded_picket_fence: { name: 'Cerquinha', fit: { length: 12 }, roughness: 0.7, noAO: true, paint: () => 0xffffff },
      championship_podium: { name: 'Pódio', fit: { length: 9 }, roughness: 0.5, noAO: true, paint: (p) => p.x < 0.33 ? 0xc0c0c0 : p.x < 0.67 ? 0xffd166 : 0xcd7f32 },
      cardboard_box_01: { name: 'Caixa de Papelão', fit: { length: 9 }, mass: 1.2, roughness: 0.9, paint: (p, n) => n.y > 0.8 ? 0xb88a52 : 0xc9a46b },
      computer_speaker_01: { name: 'Caixinha de Som', fit: { height: 6 }, roughness: 0.4, paint: (p, n) => (n.z > 0.7 && p.rxy < 0.3) ? 0x495057 : 0x22252b }
    });

    // ============================================================================
    // SHADERS DO MUNDO (estilo Bruno Simon): ÁGUA, GRAMA E FOLHAGEM
    // ============================================================================
    const worldUniforms = {
      uTime: { value: 0 },
      uPlayer: { value: new THREE.Vector3(0, 999, 0) },
      // Velocidade do carrinho (por passo x 3): plantas e grama se abrem com o deslocamento de ar
      uPlayerVel: { value: new THREE.Vector3() },
      // Vento global: (direção x, direção z, força). Brisa suave que gira devagar + rajadas
      uWind: { value: new THREE.Vector3(0.8, 0.6, 0.55) }
    };
    // Estado do vento usado também pela física (folhas, papéis, brasas, fumaça)
    const windState = { x: 0.8, z: 0.6, strength: 0.55, gustBoost: 0, gustTimer: 0 };
    function updateWind(time, dt) {
      const a = 0.65 + Math.sin(time * 0.05) * 0.5 + Math.sin(time * 0.013) * 0.4;
      windState.x = Math.cos(a); windState.z = Math.sin(a);
      // Brisa base + rajadas suaves + rajada forte pedida na Ilha da Fogueira
      const gust = Math.max(0, Math.sin(time * 0.31) * Math.sin(time * 0.17 + 1.3)) * 0.55;
      if (windState.gustTimer > 0) windState.gustTimer -= dt;
      windState.gustBoost += ((windState.gustTimer > 0 ? 1.6 : 0) - windState.gustBoost) * Math.min(1, dt * 1.8);
      windState.strength = 0.45 + gust + windState.gustBoost;
      worldUniforms.uWind.value.set(windState.x, windState.z, windState.strength);
    }

    // ---------- Água estilizada (gradiente de profundidade, espuma na borda e brilhos) ----------
    function createWaterMaterial(opts = {}) {
      return withFog(new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: worldUniforms.uTime,
          uShallow: { value: new THREE.Color(opts.shallow || 0x6fe3f0) },
          uDeep: { value: new THREE.Color(opts.deep || 0x2373c9) },
          uFoam: { value: new THREE.Color(0xffffff) },
          uScale: { value: opts.scale || 1 },
          uFlow: { value: new THREE.Vector2(...(opts.flow || [0, 0])) }
        },
        vertexShader: `
          uniform float uTime;
          attribute float aEdge;
          varying float vEdge;
          varying vec2 vPos;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vEdge = aEdge;
            vPos = world.xz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }`,
        fragmentShader: `
          uniform float uTime;
          uniform float uScale;
          uniform vec2 uFlow;
          uniform vec3 uShallow;
          uniform vec3 uDeep;
          uniform vec3 uFoam;
          varying float vEdge;
          varying vec2 vPos;
          void main() {
            vec2 q = vPos * uScale - uFlow * uTime;
            float n = sin(q.x * 0.55 + uTime * 1.3) * sin(q.y * 0.47 - uTime * 0.9)
                    + 0.6 * sin((q.x + q.y) * 0.23 + uTime * 0.7)
                    + 0.35 * sin(q.x * 1.7 - q.y * 1.3 + uTime * 2.1);
            vec3 col = mix(uDeep, uShallow, smoothstep(0.15, 1.0, vEdge));
            col += smoothstep(1.25, 1.7, n) * 0.35;
            float foam = smoothstep(0.84, 0.94, vEdge + n * 0.035);
            col = mix(col, uFoam, foam);
            gl_FragColor = vec4(col, mix(0.82, 1.0, foam));
          }`
      }));
    }

    // Geometria de "blob" em anéis concêntricos com aEdge (0 = centro, 1 = margem)
    function createBlobGeometry(radiusAt, rings = 10, segments = 72) {
      const pos = [0, 0, 0], edge = [0], idx = [];
      for (let r = 1; r <= rings; r++) {
        for (let s = 0; s < segments; s++) {
          const a = (s / segments) * Math.PI * 2;
          const rad = radiusAt(a) * (r / rings);
          pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
          edge.push(r / rings);
        }
      }
      for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
      for (let r = 1; r < rings; r++) {
        const a0 = 1 + (r - 1) * segments, a1 = 1 + r * segments;
        for (let s = 0; s < segments; s++) {
          const s1 = (s + 1) % segments;
          idx.push(a0 + s, a0 + s1, a1 + s, a0 + s1, a1 + s1, a1 + s);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    // Poça do copo d'água agora usa o mesmo shader de água
    puddleMesh.geometry.dispose();
    puddleMesh.geometry = createBlobGeometry(a => 7.5 * (1 + 0.12 * Math.sin(a * 3) + 0.06 * Math.sin(a * 7)), 6, 48);
    puddleMesh.rotation.set(0, 0, 0);
    puddleMesh.material = createWaterMaterial({ shallow: 0x8ef0ff, deep: 0x3aa6e8, scale: 2.2 });
    puddleMesh.renderOrder = 3;

    // ---------- Lago do quarto ----------
    const LAKE = { x: 76, z: 72, rx: 19, rz: 15 };
    function lakeRadiusFactor(a) { return 1 + 0.09 * Math.sin(a * 3 + 0.6) + 0.05 * Math.sin(a * 5 + 1.3); }
    function isInLake(x, z, margin = 0) {
      const dx = (x - LAKE.x) / LAKE.rx, dz = (z - LAKE.z) / LAKE.rz;
      const a = Math.atan2(dz, dx);
      return Math.hypot(dx, dz) < lakeRadiusFactor(a) - margin;
    }
    (function createLake() {
      const radiusAt = (a) => lakeRadiusFactor(a);
      const sand = new THREE.Mesh(
        createBlobGeometry(a => radiusAt(a) * 1.12, 4, 72),
        new THREE.MeshStandardMaterial({ color: 0xf1d9a6, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 })
      );
      sand.scale.set(LAKE.rx, 1, LAKE.rz);
      sand.position.set(LAKE.x, FLOOR_SURFACE_Y + 0.03, LAKE.z);
      sand.receiveShadow = true;
      bedroomWorld.add(sand);
      const water = new THREE.Mesh(createBlobGeometry(radiusAt, 12, 72), createWaterMaterial({ scale: 1 }));
      water.scale.set(LAKE.rx, 1, LAKE.rz);
      water.position.set(LAKE.x, FLOOR_SURFACE_Y + 0.09, LAKE.z);
      water.renderOrder = 3;
      water.name = 'Lago';
      bedroomWorld.add(water);
    })();

    // ---------- Grama (lâminas com vento e empurrão do carrinho) ----------
    const grassMaterial = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        uTime: worldUniforms.uTime,
        uPlayer: worldUniforms.uPlayer,
        uPlayerVel: worldUniforms.uPlayerVel,
        uWind: worldUniforms.uWind,
        uBase: { value: new THREE.Color(0x2f6b2a) },
        uTip: { value: new THREE.Color(0xb5e85c) }
      },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uPlayer;
        uniform vec3 uPlayerVel;
        uniform vec3 uWind;
        attribute vec2 aCorner;
        attribute vec3 aParams;
        varying float vTip;
        varying float vRand;
        void main() {
          vec3 base = position;
          float h = aParams.x;
          float ang = aParams.y;
          vec3 side = vec3(cos(ang), 0.0, sin(ang));
          float tip = aCorner.y;
          vec3 p = base + side * aCorner.x * 0.2 * (1.0 - tip);
          // Lâmina flexível: curva quadrática (a ponta verga mais que o meio), rajadas que atravessam o campo
          float bend = tip * tip;
          vec2 wdir = uWind.xy;
          float ws = uWind.z;
          float gustWave = 0.5 + 0.5 * sin(dot(base.xz, wdir) * 0.09 - uTime * 1.4);
          float wob = sin(uTime * 2.1 + base.x * 0.35 + base.z * 0.25 + aParams.z * 6.0) * 0.4 + sin(uTime * 3.7 + base.z * 0.8) * 0.15;
          p.xz += wdir * bend * h * ws * (0.25 + gustWave * 0.6 + wob * 0.35);
          p.xz += vec2(-wdir.y, wdir.x) * bend * h * wob * 0.15;
          vec2 d = base.xz - uPlayer.xz;
          float dist = length(d);
          float spd = length(uPlayerVel.xz);
          float push = (1.0 - smoothstep(0.0, 3.4 + spd * 2.0, dist)) * step(abs(base.y - uPlayer.y), 3.0);
          vec2 dir = dist > 0.001 ? d / dist : vec2(0.0);
          p.xz += (dir * (0.9 + spd * 0.6) + uPlayerVel.xz * 0.5) * push * bend * h;
          p.y += tip * h * (1.0 - push * 0.65) * (1.0 - 0.18 * ws * gustWave * bend);
          vTip = tip;
          vRand = aParams.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uBase;
        uniform vec3 uTip;
        varying float vTip;
        varying float vRand;
        void main() {
          vec3 c = mix(uBase, uTip, vTip) * (0.82 + vRand * 0.3);
          gl_FragColor = vec4(c, 1.0);
        }`
    });
    withFog(grassMaterial);

    // Grama em lote: as chamadas juntam pontos e, no fim do lote, vira UMA malha por região de 80×80
    // (antes cada moita/ilha criava a sua malha: 117 chamadas de desenho só de grama)
    const GRASS_REGION = 80;
    const pendingGrass = new Map();
    let grassFlushScheduled = false;
    function createGrassPatch(points) {
      points.forEach((pt) => {
        if ((pt.x >= QUINTAL_MIN_X) !== IS_QUINTAL) return; // grama do outro cenário
        const k = Math.floor(pt.x / GRASS_REGION) + ',' + Math.floor(pt.z / GRASS_REGION) + (pt.y > -15 ? 'd' : 'f');
        let arr = pendingGrass.get(k);
        if (!arr) { arr = []; pendingGrass.set(k, arr); }
        arr.push(pt);
      });
      if (!grassFlushScheduled) { grassFlushScheduled = true; setTimeout(flushGrass, 0); }
    }
    function flushGrass() {
      grassFlushScheduled = false;
      pendingGrass.forEach((pts) => { if (pts.length) buildGrassMesh(pts); });
      pendingGrass.clear();
    }
    function buildGrassMesh(points) {
      const n = points.length;
      const pos = new Float32Array(n * 9), corner = new Float32Array(n * 6), params = new Float32Array(n * 9);
      points.forEach((pt, i) => {
        const h = pt.h, ang = Math.random() * Math.PI, rnd = Math.random();
        const corners = [[-1, 0], [1, 0], [0, 1]];
        for (let k = 0; k < 3; k++) {
          pos.set([pt.x, pt.y, pt.z], i * 9 + k * 3);
          corner.set(corners[k], i * 6 + k * 2);
          params.set([h, ang, rnd], i * 9 + k * 3);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      g.setAttribute('aParams', new THREE.BufferAttribute(params, 3));
      g.computeBoundingSphere();
      g.boundingSphere.radius += 2;
      const mesh = new THREE.Mesh(g, grassMaterial);
      scene.add(mesh);
      return mesh;
    }

    // ---------- Folhagem (copas com folhas recortadas e balanço do vento) ----------
    const leafTexture = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(32, 2);
      ctx.bezierCurveTo(58, 18, 56, 46, 32, 62);
      ctx.bezierCurveTo(8, 46, 6, 18, 32, 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(32, 8); ctx.lineTo(32, 58); ctx.stroke();
      return new THREE.CanvasTexture(c);
    })();

    // Folhagem fluida: cada folha tremula em torno do próprio centro, a copa verga com o vento
    // (mais no topo, aHeight), rajadas viajam pelo mundo e o carrinho abre caminho ao passar.
    function createFoliageMaterial(colorA, colorB) {
      return withFog(new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
          uTime: worldUniforms.uTime,
          uPlayer: worldUniforms.uPlayer,
          uPlayerVel: worldUniforms.uPlayerVel,
          uWind: worldUniforms.uWind,
          uMap: { value: leafTexture },
          uColorA: { value: new THREE.Color(colorA) },
          uColorB: { value: new THREE.Color(colorB) }
        },
        vertexShader: `
          uniform float uTime;
          uniform vec3 uPlayer;
          uniform vec3 uPlayerVel;
          uniform vec3 uWind;
          attribute vec3 aCenter;
          attribute float aShade;
          attribute float aHeight;
          varying vec2 vUv;
          varying float vShade;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vec3 wc = (modelMatrix * vec4(aCenter, 1.0)).xyz; // centro da folha no mundo (vaso pode se mover)
            float ph = wc.x * 0.19 + wc.z * 0.23 + wc.y * 0.11;
            vec2 wdir = uWind.xy;
            float ws = uWind.z;
            float bend = aHeight * aHeight;
            float gustWave = 0.5 + 0.5 * sin(dot(wc.xz, wdir) * 0.06 - uTime * 1.1);
            float sway = sin(uTime * 1.25 + ph) * 0.55 + sin(uTime * 2.3 + ph * 1.9) * 0.25 + sin(uTime * 0.6 + ph * 0.5) * 0.35;
            vec2 offs = wdir * ws * bend * (0.35 + gustWave * 0.9 + sway * 0.4);
            offs += vec2(-wdir.y, wdir.x) * sin(uTime * 1.7 + ph * 2.3) * 0.22 * ws * bend;
            vec2 d = wc.xz - uPlayer.xz;
            float dist = length(d);
            float vy = abs(wc.y - uPlayer.y - 1.0);
            float near = (1.0 - smoothstep(1.5, 7.5, dist)) * (1.0 - smoothstep(2.5, 7.5, vy));
            float spd = length(uPlayerVel.xz);
            vec2 dirP = dist > 0.001 ? d / dist : vec2(0.0);
            offs += dirP * near * (0.35 + spd * 1.4) * (0.45 + bend);
            offs += uPlayerVel.xz * near * 0.7;
            float flut = sin(uTime * (6.0 + aShade * 4.0) + ph * 7.0) * (0.1 + ws * 0.22 + near * spd * 1.8);
            wp.xz += offs;
            wp.y += (uv.x - 0.5) * flut - dot(offs, offs) * 0.06 - near * spd * 0.35 * bend;
            vUv = uv;
            vShade = aShade;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform vec3 uColorA;
          uniform vec3 uColorB;
          varying vec2 vUv;
          varying float vShade;
          void main() {
            vec4 t = texture2D(uMap, vUv);
            if (t.a < 0.5) discard;
            gl_FragColor = vec4(mix(uColorA, uColorB, vShade) * (0.78 + 0.22 * t.r), 1.0);
          }`
      }));
    }
    // Plantinhas em vaso (criadas antes deste shader) ganham agora as folhas com vento
    {
      const cache = new Map();
      pendingLeafMeshes.forEach(({ mesh, colors }) => {
        const key = colors.join('-');
        if (!cache.has(key)) cache.set(key, createFoliageMaterial(colors[0], colors[1]));
        mesh.material.dispose();
        mesh.material = cache.get(key);
      });
    }
    const foliageMaterials = [
      createFoliageMaterial(0x2d6a2f, 0xa7e05a),
      createFoliageMaterial(0x7a2e5c, 0xffb3d1),   // cerejeira rosa
      createFoliageMaterial(0x9a4a12, 0xffc65a)    // outono
    ];

    const treeCrowns = []; // usados pelas folhas caindo
    function createTree(x, z, y, scale = 1, variant = 0) {
      const group = new THREE.Group();
      if ((x >= QUINTAL_MIN_X) !== IS_QUINTAL) { obstacles.push({ x, z, r: 0, h: 0, name: 'ÁRVORE (outro cenário)', isStatic: true, level: 'floor' }); return group; }
      group.position.set(x, y, z);
      const trunkH = 7 * scale;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45 * scale, 0.75 * scale, trunkH, 8),
        new THREE.MeshStandardMaterial({ color: 0x7a4b2a, roughness: 0.9 })
      );
      trunk.position.y = trunkH / 2;
      trunk.castShadow = true;
      group.add(trunk);

      const R = 4.2 * scale, count = Math.round(260 * scale);
      const cy = trunkH + R * 0.55;
      const pos = [], uv = [], centers = [], shade = [], heights = [], idx = [];
      const right = new THREE.Vector3(), up = new THREE.Vector3(), nrm = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const u = Math.random(), v = Math.random();
        const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
        const rr = R * Math.cbrt(0.35 + Math.random() * 0.65);
        const c = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * rr, Math.cos(ph) * rr * 0.8 + cy, Math.sin(ph) * Math.sin(th) * rr);
        nrm.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        right.set(0, 1, 0).cross(nrm).normalize();
        if (right.lengthSq() < 0.01) right.set(1, 0, 0);
        up.crossVectors(nrm, right).normalize();
        const s = 0.9 * scale;
        const base = pos.length / 3;
        [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([a, b, uu, vv]) => {
          pos.push(c.x + (right.x * a + up.x * b) * s, c.y + (right.y * a + up.y * b) * s, c.z + (right.z * a + up.z * b) * s);
          uv.push(uu, vv);
          centers.push(c.x, c.y, c.z); // local (a copa fica dentro do grupo da árvore)
          shade.push(THREE.MathUtils.clamp((c.y - (cy - R)) / (2 * R) + 0.15 * Math.sign(c.x + c.z), 0, 1));
          heights.push(THREE.MathUtils.clamp((c.y - trunkH * 0.6) / (cy + R - trunkH * 0.6), 0.25, 1) * Math.min(1.25, 0.8 + scale * 0.3));
        });
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
      g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
      g.setAttribute('aHeight', new THREE.Float32BufferAttribute(heights, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      g.boundingSphere.radius += 3;
      const crown = new THREE.Mesh(g, foliageMaterials[variant % foliageMaterials.length]);
      group.add(crown);
      scene.add(group);
      treeCrowns.push({ x, z, y: y + cy, r: R, groundY: y, variant });
      obstacles.push({ x, z, r: 0.9 * scale + 0.3, h: trunkH + R, name: 'ÁRVORE', isStatic: true, level: levelOfY(y) });
      return group;
    }

    // ---------- Folhas caindo das copas ----------
    const FALLING_LEAVES = 140;
    const leafColors = [0x6cbf3b, 0xa7e05a, 0xffb3d1, 0xffc65a, 0xff8f3d];
    const fallingLeavesMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: leafTexture, alphaTest: 0.5, side: THREE.DoubleSide }),
      FALLING_LEAVES
    );
    fallingLeavesMesh.frustumCulled = false;
    scene.add(fallingLeavesMesh);
    const fallingLeaves = [];
    const tmpLeafObj = new THREE.Object3D();
    function respawnLeaf(leaf, burst) {
      const crown = treeCrowns[Math.floor(Math.random() * treeCrowns.length)];
      if (!crown) { leaf.active = false; return; }
      leaf.active = true;
      leaf.x = crown.x + (Math.random() - 0.5) * crown.r * 1.6;
      leaf.z = crown.z + (Math.random() - 0.5) * crown.r * 1.6;
      leaf.y = crown.y + (Math.random() - 0.3) * crown.r;
      leaf.ground = crown.groundY + 0.06;
      leaf.vy = -(0.9 + Math.random() * 0.9) * (burst ? 1.6 : 1);
      leaf.phase = Math.random() * 10;
      leaf.spin = (Math.random() - 0.5) * 4;
      leaf.rest = 0;
      leaf.delay = burst ? 0 : Math.random() * 6;
      const palette = crown.variant === 1 ? [0xffb3d1, 0xff8fab] : crown.variant === 2 ? [0xffc65a, 0xff8f3d] : [0x6cbf3b, 0xa7e05a];
      fallingLeavesMesh.setColorAt(leaf.i, new THREE.Color(palette[Math.floor(Math.random() * palette.length)]));
      if (fallingLeavesMesh.instanceColor) fallingLeavesMesh.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < FALLING_LEAVES; i++) fallingLeaves.push({ i, active: false });
    function burstLeaves(count = 60) {
      fallingLeaves.slice(0, count).forEach(l => respawnLeaf(l, true));
    }
    function updateFallingLeaves(time, dt) {
      fallingLeaves.forEach((leaf) => {
        if (!leaf.active) { respawnLeaf(leaf, false); }
        if (leaf.delay > 0) { leaf.delay -= dt; tmpLeafObj.scale.setScalar(0.0001); }
        else if (leaf.y > leaf.ground) {
          // Cai planando, levada pela brisa; folhas sopradas pelo carrinho sobem antes de cair
          leaf.up = Math.max(0, (leaf.up || 0) - 7 * dt);
          leaf.kx = (leaf.kx || 0) * Math.exp(-1.6 * dt); leaf.kz = (leaf.kz || 0) * Math.exp(-1.6 * dt);
          leaf.y += (leaf.vy + leaf.up) * dt;
          leaf.x += (Math.sin(time * 1.8 + leaf.phase) * 1.4 + windState.x * windState.strength * 2.2 + leaf.kx) * dt;
          leaf.z += (Math.cos(time * 1.3 + leaf.phase) * 1.1 + windState.z * windState.strength * 2.2 + leaf.kz) * dt;
          tmpLeafObj.scale.setScalar(1);
          tmpLeafObj.rotation.set(Math.sin(time * 2 + leaf.phase) * 1.2, time * leaf.spin, Math.cos(time * 1.7 + leaf.phase) * 1.2);
        } else {
          leaf.y = leaf.ground;
          leaf.rest += dt;
          // Carrinho passando rápido perto: a folha do chão é soprada para o lado e para cima
          const cdx = leaf.x - vehicle.position.x, cdz = leaf.z - vehicle.position.z, sp = Math.abs(carSpeed) * 60;
          if (sp > 4 && Math.abs(leaf.ground - vehicle.position.y) < 3 && cdx * cdx + cdz * cdz < 25) {
            const d = Math.hypot(cdx, cdz) || 1;
            leaf.kx = cdx / d * sp * 0.5 + Math.sin(carAngle) * sp * 0.2;
            leaf.kz = cdz / d * sp * 0.5 + Math.cos(carAngle) * sp * 0.2;
            leaf.up = 3 + Math.random() * 3;
            leaf.y = leaf.ground + 0.05;
            leaf.rest = 0;
          }
          tmpLeafObj.rotation.set(-Math.PI / 2, 0, leaf.phase);
          tmpLeafObj.scale.setScalar(Math.max(0.0001, 1 - Math.max(0, leaf.rest - 4) / 1.5));
          if (leaf.rest > 5.5) respawnLeaf(leaf, false);
        }
        tmpLeafObj.position.set(leaf.x, leaf.y, leaf.z);
        tmpLeafObj.updateMatrix();
        fallingLeavesMesh.setMatrixAt(leaf.i, tmpLeafObj.matrix);
      });
      fallingLeavesMesh.instanceMatrix.needsUpdate = true;
    }

    // ---------- Partículas de efeito (confete, respingos, faíscas) ----------
    // Pool instanciado: 1 chamada de desenho para todas as partículas (antes: uma Mesh nova por partícula)
    const FX_MAX = 700;
    const fxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.35, 0.12), new THREE.MeshBasicMaterial({ color: 0xffffff }), FX_MAX);
    fxMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FX_MAX * 3).fill(1), 3);
    fxMesh.frustumCulled = false;
    scene.add(fxMesh);
    const fxParticles = []; // partículas vivas
    const fxSlots = Array.from({ length: FX_MAX }, (_, i) => ({ i, alive: false }));
    let fxNext = 0;
    const _fxObj = new THREE.Object3D(), _fxCol = new THREE.Color();
    _fxObj.scale.setScalar(0); _fxObj.updateMatrix();
    for (let i = 0; i < FX_MAX; i++) fxMesh.setMatrixAt(i, _fxObj.matrix);
    function spawnFx(x, y, z, vx, vy, vz, color, life = 1.6, gravity = 14, size = 1) {
      const p = fxSlots[fxNext];
      fxNext = (fxNext + 1) % FX_MAX;
      if (!p.alive) fxParticles.push(p); // slot reaproveitado: a partícula mais antiga dá lugar à nova
      Object.assign(p, { alive: true, x, y, z, vx, vy, vz, life, maxLife: life, gravity, size, rx: 0, ry: 0, spin: (Math.random() - 0.5) * 12 });
      fxMesh.instanceColor.setXYZ(p.i, ...(_fxCol.setHex(color).toArray()));
      fxMesh.instanceColor.needsUpdate = true;
    }
    function updateFx(dt) {
      if (!fxParticles.length) return;
      for (let n = fxParticles.length - 1; n >= 0; n--) {
        const p = fxParticles[n];
        p.vy -= p.gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rx += p.spin * dt; p.ry += p.spin * 0.7 * dt;
        p.life -= dt;
        const k = Math.max(0.001, p.life / p.maxLife);
        _fxObj.position.set(p.x, p.y, p.z);
        _fxObj.rotation.set(p.rx, p.ry, 0);
        _fxObj.scale.setScalar(p.life > 0 ? Math.min(1, k * 2) * p.size : 0);
        _fxObj.updateMatrix();
        fxMesh.setMatrixAt(p.i, _fxObj.matrix);
        if (p.life <= 0) { p.alive = false; fxParticles.splice(n, 1); }
      }
      fxMesh.instanceMatrix.needsUpdate = true;
    }
    function confettiBurst(x, y, z, count = 70) {
      const colors = [0xffceca, 0xe88eff, 0xd5ff95, 0xffc67b, 0x5fc8ff, 0xff6a7c];
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 8;
        spawnFx(x, y, z, Math.cos(a) * s, 10 + Math.random() * 12, Math.sin(a) * s, colors[i % colors.length], 2.2, 16);
      }
    }
    function splashAt(x, y, z, count = 10, power = 1) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, s = (1.5 + Math.random() * 3) * power;
        spawnFx(x, y, z, Math.cos(a) * s, (4 + Math.random() * 5) * power, Math.sin(a) * s, Math.random() > 0.5 ? 0x8ef0ff : 0xffffff, 0.7, 18, 0.6);
      }
    }

    // ---------- Onda de revelação do mundo (anel #e88eff da intro do DS) ----------
    const revealRings = [];
    function spawnRevealWave(x, y, z) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.06, 8, 96),
        new THREE.MeshBasicMaterial({ color: 0xe88eff, transparent: true, opacity: 0.9, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, y + 0.4, z);
      scene.add(ring);
      revealRings.push({ ring, t: 0 });
    }
    function updateRevealRings(dt) {
      for (let i = revealRings.length - 1; i >= 0; i--) {
        const r = revealRings[i];
        r.t += dt;
        const k = r.t / 2.4;
        const s = 1 + k * 180;
        r.ring.scale.set(s, s, 1 + k * 30);
        r.ring.material.opacity = 0.9 * (1 - k);
        if (k >= 1) { scene.remove(r.ring); revealRings.splice(i, 1); }
      }
    }

    // ============================================================================
    // ILHAS DO RAVI — áreas temáticas com grama, árvores e pontos interativos
    // ============================================================================
    const ISLAND_TOP = 0.5;
    const ISLAND_Y = FLOOR_SURFACE_Y + ISLAND_TOP;
    function islandRadiusFactor(island, a) {
      return 1 + 0.07 * Math.sin(a * 3 + island.seed) + 0.04 * Math.sin(a * 7 + island.seed * 2);
    }
    function islandAt(x, z) {
      for (const isl of islands) {
        const dx = x - isl.x, dz = z - isl.z;
        const d = Math.hypot(dx, dz);
        if (d < isl.r * islandRadiusFactor(isl, Math.atan2(dz, dx)) - 0.2) return isl;
      }
      return null;
    }
    // Altura extra do chão do quarto (ilhas e fundo do lago) — usada pela física do carrinho
    function floorExtraHeight(x, z) {
      if (islandAt(x, z)) return ISLAND_TOP;
      if (isInLake(x, z, 0.05)) return -0.32;
      return 0;
    }

    const islands = [];
    const islandGroundMat = [
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0x4f9a3e, roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.95 })
    ];

    function createIslandLabel(text, x, y, z) {
      const tex = createDsLabelTexture(text, { width: 640, height: 128 });
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
      sprite.scale.set(14, 2.8, 1);
      sprite.position.set(x, y, z);
      scene.add(sprite);
      return sprite;
    }

    function createIsland(def) {
      const isl = Object.assign({ seed: Math.random() * 10, visited: false }, def);
      // Terreno: disco irregular com borda de terra
      const geo = new THREE.CylinderGeometry(isl.r, isl.r * 1.04, ISLAND_TOP, 64, 1);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        const a = Math.atan2(z, x);
        const f = islandRadiusFactor(isl, a);
        p.setXYZ(i, x * f, p.getY(i), z * f);
      }
      geo.computeVertexNormals();
      const ground = new THREE.Mesh(geo, islandGroundMat);
      ground.position.set(isl.x, FLOOR_SURFACE_Y + ISLAND_TOP / 2, isl.z);
      ground.receiveShadow = true;
      bedroomWorld.add(ground);

      // Grama densa
      const pts = [];
      const blades = Math.round(isl.r * isl.r * 9);
      for (let i = 0; i < blades; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * isl.r * islandRadiusFactor(isl, a) * 0.97;
        pts.push({ x: isl.x + Math.cos(a) * rr, y: ISLAND_Y, z: isl.z + Math.sin(a) * rr, h: 0.55 + Math.random() * 0.9 });
      }
      createGrassPatch(pts);

      // Ponto interativo: anel no chão + diamante flutuante (pin do mapa do DS)
      const [px, pz] = isl.point;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.95, 40),
        new THREE.MeshBasicMaterial({ color: 0xffceca, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(px, ISLAND_Y + 0.05, pz);
      scene.add(ring);
      const diamond = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.85),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffceca, emissiveIntensity: 0.55, roughness: 0.3 })
      );
      diamond.scale.y = 1.35;
      diamond.position.set(px, ISLAND_Y + 3, pz);
      diamond.castShadow = true;
      scene.add(diamond);
      isl.pointMeshes = { ring, diamond };
      isl.label = createIslandLabel(isl.label || isl.name, isl.x, ISLAND_Y + (isl.labelHeight || 15), isl.z);
      islands.push(isl);
      return isl;
    }

    // Placas e posições evitam o circuito do chão e os móveis
    const fireIsland = createIsland({
      id: 'fire', name: 'Posto do Bombeiro', x: -120, z: 78, r: 12, point: [-111, 70],
      text: 'Aqui o caminhãozinho do Ravi descansa, enche o tanque e se prepara para a próxima missão. Todo bombeiro precisa de um posto!',
      action: 'Encher o tanque'
    });
    const spaceIsland = createIsland({
      id: 'space', name: 'Ilha Espacial', x: -140, z: -58, r: 12, point: [-131, -49],
      text: 'Três, dois, um... O foguete do Ravi está pronto para visitar a Lua e as estrelas. Aperte o botão e veja ele decolar!',
      action: 'Lançar o foguete', labelHeight: 20
    });
    const musicIsland = createIsland({
      id: 'music', name: 'Ilha da Música', x: 104, z: -46, r: 12, point: [97, -38],
      text: 'Piano, guitarra e caixinhas de som: a banda do Ravi ensaia aqui todos os dias. Qual música vamos tocar?',
      action: 'Tocar uma música',
      actions: [
        { label: '🎵 Brilha, brilha estrelinha', run: () => playIslandSong('estrelinha') },
        { label: '🐋 A baleia é amiga da sereia', run: () => playIslandSong('baleia') },
        { label: '🐮 Ia ia ô (Seu Lobato)', run: () => playIslandSong('lobato') },
        { label: '🐋 Ouvir a baleia original ↗', run: () => openExternal('https://www.youtube.com/watch?v=xK4sbpVnzTE') }
      ]
    });
    const toysIsland = createIsland({
      id: 'toys', name: 'Ilha dos Brinquedos', x: -52, z: 79, r: 11, point: [-45, 71],
      text: 'Dados gigantes, skate, bola e quebra-cabeça. Na ilha dos brinquedos a brincadeira nunca acaba!',
      action: 'Hora de brincar!'
    });
    const lakeIsland = createIsland({
      id: 'lake', name: 'Ilha do Lago', x: 79, z: 73, r: 5.5, point: [79, 69.5],
      text: 'Uma ilhazinha no meio do lago, cheia de cogumelos e árvores. Os peixinhos adoram quando alguém aparece por aqui!',
      action: 'Alimentar os peixinhos', labelHeight: 17
    });
    // Ilha das Cores: caixa de lápis de cor, lápis espalhados, potes de guache e tinta → personalização do carrinho
    const PAINT_ISLAND = { x: -108, z: -6 };
    const paintIsland = createIsland({
      id: 'paint', name: 'Ilha das Cores', x: PAINT_ISLAND.x, z: PAINT_ISLAND.z, r: 10, point: [PAINT_ISLAND.x + 4, PAINT_ISLAND.z + 5],
      text: 'Lápis de cor, guache e tinta: aqui o Ravi pinta o caminhãozinho do jeito que quiser. Escolha as cores da carroceria, das rodas, dos pneus e do vidro!',
      actions: [{ label: '🎨 Personalizar o carrinho', run: () => openPaintShop() }]
    });
    (function buildPaintIslandProps() {
      const X = PAINT_ISLAND.x, Z = PAINT_ISLAND.z, Y = ISLAND_Y;
      const CRAYON_COLORS = [0xe63946, 0xfb8500, 0xffbe0b, 0x7ee787, 0x2a9d8f, 0x3a86ff, 0x8338ec, 0xff8fab, 0x8d5524, 0x222326];
      function crayon(color, len = 4.2) {
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, len, 8), mat);
        body.position.y = len / 2;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 8), mat);
        tip.position.y = len + 0.4;
        const label = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, len * 0.55, 8), new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.7 }));
        label.position.y = len * 0.42;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.18, 8), mat);
        band.position.y = len * 0.42;
        g.add(body, tip, label, band);
        g.traverse(o => { if (o.isMesh) o.castShadow = true; });
        return g;
      }
      // Caixa de lápis aberta com 10 lápis em pé (degrau de alturas, como na caixa nova)
      const box = new THREE.Group();
      box.position.set(X - 3, Y, Z - 2.5);
      box.rotation.y = 0.35;
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.6 });
      const front = new THREE.Mesh(new THREE.BoxGeometry(7.2, 3.2, 0.25), boxMat);
      front.position.set(0, 1.6, 1.0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(7.2, 5.4, 0.25), boxMat);
      back.position.set(0, 2.7, -1.0);
      const sides = [-3.6, 3.6].map((sx) => { const s = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.2, 2.2), boxMat); s.position.set(sx, 1.6, 0); return s; });
      const bottom = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.25, 2.2), boxMat);
      bottom.position.y = 0.12;
      box.add(front, back, bottom, ...sides);
      // Faixa colorida estampada na frente da caixa
      const c = document.createElement('canvas'); c.width = 512; c.height = 220;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffd23f'; ctx.fillRect(0, 0, 512, 220);
      const stripe = ['#e63946', '#fb8500', '#ffbe0b', '#7ee787', '#3a86ff', '#8338ec'];
      stripe.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(i * 512 / 6, 150, 512 / 6, 40); });
      ctx.fillStyle = '#251f2b'; ctx.font = 'bold 74px "Amatic SC", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('LÁPIS DE COR', 256, 110);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(7.0, 3.0), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.6 }));
      face.position.set(0, 1.6, 1.13);
      box.add(face);
      CRAYON_COLORS.forEach((col, i) => {
        const cr = crayon(col, 4.6 + (i % 2) * 0.4);
        cr.position.set(-3.1 + i * 0.69, 0.25, 0);
        box.add(cr);
      });
      box.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(box);
      obstacles.push({ x: box.position.x, z: box.position.z, r: 3.8, box: { hx: 3.7, hz: 1.2 }, boxRot: 0.35, name: 'CAIXA DE LÁPIS DE COR', isStatic: true, level: 'floor', h: 6 });
      // Lápis espalhados deitados na grama
      [[4.5, -3.5, 0.4], [6.5, 1.0, 2.1], [-6.5, 3.5, -0.8], [1.2, 6.5, 1.3], [-2.0, 5.2, 2.7]].forEach(([dx, dz, rot], i) => {
        const cr = crayon(CRAYON_COLORS[(i * 3) % CRAYON_COLORS.length], 4.0);
        cr.rotation.set(0, rot, Math.PI / 2);
        cr.position.set(X + dx, Y + 0.32, Z + dz);
        scene.add(cr);
      });
      // Potes de guache com tampa colorida e tinta escorrendo
      [[5.5, 4.5, 0xe63946], [7.2, 6.0, 0x3a86ff], [3.8, 7.2, 0xffbe0b], [8.2, 3.2, 0x7ee787]].forEach(([dx, dz, col]) => {
        const g = new THREE.Group();
        const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 20), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, roughness: 0.1 }));
        jar.position.y = 0.8;
        const paint = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 1.2, 20), new THREE.MeshStandardMaterial({ color: col, roughness: 0.35 }));
        paint.position.y = 0.62;
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.35, 20), new THREE.MeshStandardMaterial({ color: col, roughness: 0.3 }));
        lid.position.set(0.9, 0.2, 0.4); lid.rotation.z = 1.3; // tampa aberta caída ao lado
        const drip = new THREE.Mesh(new THREE.CircleGeometry(1.1, 20), new THREE.MeshStandardMaterial({ color: col, roughness: 0.2 }));
        drip.rotation.x = -Math.PI / 2; drip.position.set(-0.6, 0.03, 0.5); drip.scale.set(1.3, 0.8, 1);
        g.add(jar, paint, lid, drip);
        g.position.set(X + dx, Y, Z + dz);
        g.traverse(o => { if (o.isMesh) o.castShadow = true; });
        scene.add(g);
        obstacles.push({ x: X + dx, z: Z + dz, r: 1.0, name: 'POTE DE GUACHE', isStatic: true, level: 'floor', h: 1.7 });
      });
      // Bisnaga de tinta e paleta de pintor com montinhos de cores
      const palette = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.18, 28), new THREE.MeshStandardMaterial({ color: 0xc98b4b, roughness: 0.7 }));
      palette.scale.set(1.3, 1, 1);
      palette.position.set(X - 5.5, Y + 0.1, Z + 4.5);
      scene.add(palette);
      [0xe63946, 0xffbe0b, 0x3a86ff, 0x7ee787, 0xffffff, 0x8338ec].forEach((col, i) => {
        const a = (i / 6) * Math.PI * 2;
        const blob = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.25 }));
        blob.scale.set(1, 0.45, 1);
        blob.position.set(X - 5.5 + Math.cos(a) * 2.2, Y + 0.25, Z + 4.5 + Math.sin(a) * 1.6);
        scene.add(blob);
      });
      const tube = new THREE.Group();
      const tubeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 3.2, 16), new THREE.MeshStandardMaterial({ color: 0xf4f1de, roughness: 0.4, metalness: 0.3 }));
      tubeBody.rotation.z = Math.PI / 2;
      const tubeCap = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.6, 12), new THREE.MeshStandardMaterial({ color: 0x8338ec, roughness: 0.3 }));
      tubeCap.rotation.z = Math.PI / 2; tubeCap.position.x = 1.9;
      const squeeze = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshStandardMaterial({ color: 0x8338ec, roughness: 0.2 }));
      squeeze.scale.set(1.6, 0.35, 1); squeeze.position.set(3.0, -0.4, 0);
      tube.add(tubeBody, tubeCap, squeeze);
      tube.position.set(X - 1.5, Y + 0.75, Z + 7.5);
      tube.rotation.y = -0.5;
      scene.add(tube);
    })();

    // Árvores (folhagem com shader de vento)
    createTree(-110, 80, ISLAND_Y, 0.9, 0); // fora do prédio do posto
    createTree(-148, -64, ISLAND_Y, 0.8, 2);
    createTree(112, -54, ISLAND_Y, 0.85, 1);
    createTree(-60, 86, ISLAND_Y, 0.9, 1);
    createTree(-43, 87, ISLAND_Y, 0.7, 0);
    createTree(81, 76, ISLAND_Y, 0.75, 0);
    createTree(-150, 70, FLOOR_SURFACE_Y, 0.8, 2);
    createTree(108, 64, FLOOR_SURFACE_Y, 0.85, 1);

    // ============================================================================
    // CIRCUITO OFF-ROAD BAJA RALLY & ILHA DO BAJA (THIAGO RIBEIRO)
    // ============================================================================
    const rallyFlags = [];
    // ---------------------------------------------------------------------------
    // Pista Rally Baja: traçado fechado de terra batida com lamaçais, troncos, rampa de salto,
    // costelas (whoops), morro, jardim de pedras e monte de pneus. A MESMA função de altura
    // gera a malha visual e a física (o que se vê é exatamente onde o carrinho pisa).
    // Só o Baja sobe os obstáculos e anda rápido na lama; o caminhãozinho atola e é barrado.
    // ---------------------------------------------------------------------------
    const RALLY_W = 12;
    // Pista ampliada: anel externo + miolo em três laços que se cruza duas vezes:
    //  • PONTE (x 200, z -8): a estrada passa por cima de uma ponte alta e, depois, por baixo dela
    //  • MONTANHA DA CACHOEIRA (x 246, z -8): passa por dentro (túnel) e, depois, por cima (cume)
    const RALLY_POINTS = [
      [146, 26], [140, -6], [146, -38], [168, -58], [204, -60], [238, -56], [270, -60], [300, -50], [316, -22], [314, 12], [300, 44], [272, 60], [244, 54],
      [232, 34], [238, 12], [246, -8], [258, -26], [278, -28], [290, -10], [280, 10], [262, 8], [246, -8], [232, -24], [214, -30],
      [200, -8], [188, 12], [172, 14], [162, -4], [170, -26], [186, -28], [200, -8], [212, 14], [204, 32], [182, 40], [158, 38]
    ];
    const rallyCurve = new THREE.CatmullRomCurve3(RALLY_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
    const RALLY_N = 680;
    const RALLY_STEP = rallyCurve.getLength() / RALLY_N;
    const rallySamples = [];
    for (let i = 0; i < RALLY_N; i++) {
      const t = i / RALLY_N;
      const p = rallyCurve.getPointAt(t), tg = rallyCurve.getTangentAt(t);
      const l = Math.hypot(tg.x, tg.z) || 1;
      rallySamples.push({ x: p.x, z: p.z, tx: tg.x / l, tz: tg.z / l, t, y: 0, dy: 0, i });
    }
    // Cruzamentos: a passagem "de cima" ganha um platô elevado; a outra fica no chão
    const RALLY_CROSSINGS = [
      { id: 'bridge', x: 200, z: -8, overPass: 0, H: 7.5, Lh: 20 },
      { id: 'mountain', x: 246, z: -8, overPass: 1, H: 11.5, Lh: 26 }
    ];
    RALLY_CROSSINGS.forEach((c) => {
      const dist = (i) => Math.hypot(rallySamples[i].x - c.x, rallySamples[i].z - c.z);
      const clusters = [];
      rallySamples.forEach((s, i) => {
        if (dist(i) > 6) return;
        const last = clusters[clusters.length - 1];
        if (last && i - last[last.length - 1] <= 3) last.push(i); else clusters.push([i]);
      });
      const passes = clusters.map((cl) => cl.reduce((b, i) => (dist(i) < dist(b) ? i : b), cl[0]));
      c.over = passes[c.overPass];
      c.under = passes[1 - c.overPass];
      c.overT = rallySamples[c.over].t;
      c.underT = rallySamples[c.under].t;
    });
    rallySamples.forEach((s, i) => {
      RALLY_CROSSINGS.forEach((c) => {
        const d = Math.abs(i - c.over) * RALLY_STEP;
        if (d < c.Lh) s.y = Math.max(s.y, c.H * (1 - THREE.MathUtils.smoothstep(d, c.Lh * 0.24, c.Lh)));
      });
    });
    rallySamples.forEach((s, i) => {
      const a = rallySamples[(i - 1 + RALLY_N) % RALLY_N], b = rallySamples[(i + 1) % RALLY_N];
      s.dy = (b.y - a.y) / (2 * RALLY_STEP);
    });
    function rallySampleAt(t) { return rallySamples[Math.round((((t % 1) + 1) % 1) * RALLY_N) % RALLY_N]; }
    // Ponto da pista mais próximo em planta (ignora altura): usado para posicionar coisas
    function rallyNearest(x, z) {
      let best = 1e9, bi = 0;
      for (let i = 0; i < RALLY_N; i++) {
        const s = rallySamples[i];
        const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
        if (d < best) { best = d; bi = i; }
      }
      const s = rallySamples[bi];
      return { i: bi, t: s.t, lat: (x - s.x) * (-s.tz) + (z - s.z) * s.tx, dist: Math.sqrt(best), y: s.y };
    }
    // Ponto da pista sob o carrinho levando a ALTURA em conta (nos cruzamentos escolhe a estrada certa:
    // por cima da ponte/montanha ou por baixo/dentro). h = altura do carrinho acima do chão do quarto.
    function rallyNearestY(x, z, h) {
      let bi = -1, bestScore = 1e9, bestD2 = 0;
      const lim = (RALLY_SIDE + 3) * (RALLY_SIDE + 3);
      for (let i = 0; i < RALLY_N; i++) {
        const s = rallySamples[i];
        const dx = s.x - x, dz = s.z - z, d2 = dx * dx + dz * dz;
        if (d2 > lim || s.y > h + 1.6) continue;
        const score = Math.abs(s.y - h) * 4 + Math.sqrt(d2);
        if (score < bestScore) { bestScore = score; bi = i; bestD2 = d2; }
      }
      if (bi < 0) return null;
      const s = rallySamples[bi];
      const along = (x - s.x) * s.tx + (z - s.z) * s.tz;
      const n = rallySamples[(bi + (along >= 0 ? 1 : -1) + RALLY_N) % RALLY_N];
      const y = s.y + (n.y - s.y) * Math.min(1, Math.abs(along) / RALLY_STEP);
      return { i: bi, t: s.t, lat: (x - s.x) * (-s.tz) + (z - s.z) * s.tx, dist: Math.sqrt(bestD2), y, dy: s.dy, yaw: Math.atan2(s.tx, s.tz) };
    }
    const rallyT = (x, z) => rallyNearest(x, z).t;
    const RALLY_MUD = [[[140, -6], [142, -22]], [[274, -59], [300, -50]], [[208, 26], [188, 40]], [[165, 6], [162, -12]]].map(([p0, p1]) => {
      const a = rallyT(...p0), b = rallyT(...p1);
      return [Math.min(a, b), Math.max(a, b)];
    });
    const RALLY_OBSTACLES = [
      { at: [144, -30], kind: 'logs', len: 10, h: 1.9, name: 'Pilha de troncos' },
      { at: [160, -53], kind: 'kicker', len: 9, h: 2.4, name: 'Rampa de salto' },
      { at: [188, -60], kind: 'whoops', len: 20, h: 0.95, name: 'Costelas' },
      { at: [252, -58], kind: 'kicker', len: 10, h: 2.8, name: 'Rampa grande' },
      { at: [315, -12], kind: 'hill', len: 22, h: 4.4, name: 'Morro' },
      { at: [292, 48], kind: 'rocks', len: 15, h: 2.1, name: 'Jardim de pedras' },
      { at: [258, 58], kind: 'kicker', len: 9, h: 2.6, name: 'Salto do vale' },
      { at: [284, -20], kind: 'whoops', len: 12, h: 0.8, name: 'Costelas da cachoeira' },
      { at: [179, -27], kind: 'kicker', len: 8, h: 1.8, name: 'Pulo do lago' },
      { at: [168, 40], kind: 'kicker', len: 8, h: 1.9, name: 'Rampa final' }
    ].map((o) => {
      o.t = rallyT(...o.at);
      const s = rallySampleAt(o.t);
      return Object.assign(o, { cx: s.x, cz: s.z, tx: s.tx, tz: s.tz, half: o.len / 2, reach: Math.hypot(o.len / 2, RALLY_W / 2 + 1.2) });
    });
    const RALLY_TUNNELS = [{ at: [222, -58], len: 16 }, { at: [313, 22], len: 14 }].map((tn) => Object.assign(tn, { t: rallyT(...tn.at) }));
    // Túnel por dentro da montanha (passagem de baixo do cruzamento da montanha)
    RALLY_TUNNELS.push({ t: RALLY_CROSSINGS[1].underT, len: 30, mountain: true });

    // Montanha da cachoeira: morro em campo de altura, cortado/aterrado onde as estradas passam
    const MOUNTAIN = { x: 262, z: -6, r: 30, h: 20 };
    const WATERFALL = { x: 273, z: -10, lip: 13, pool: { x: 278.5, z: -10, r: 4.4 } };
    const POND = { x: 181, z: -7, r: 5.2 };
    // Passagens de estrada perto da montanha (trechos contínuos), da mais baixa para a mais alta
    const mountainPasses = (() => {
      const near = rallySamples.filter((s) => Math.hypot(s.x - MOUNTAIN.x, s.z - MOUNTAIN.z) < MOUNTAIN.r + 22);
      const groups = [];
      near.forEach((s) => { const g = groups[groups.length - 1]; if (g && s.i - g[g.length - 1].i <= 2) g.push(s); else groups.push([s]); });
      return groups.sort((a, b) => Math.max(...a.map((s) => s.y)) - Math.max(...b.map((s) => s.y)));
    })();
    function mountainBase(x, z) {
      const d = Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z);
      if (d >= MOUNTAIN.r) return 0;
      const k = 1 - d / MOUNTAIN.r;
      let h = MOUNTAIN.h * k * k * (3 - 2 * k) + (Math.sin(x * 0.45) * Math.cos(z * 0.38) * 1.4 + Math.sin(x * 1.1 + z * 0.7) * 0.5) * k;
      const dz = Math.abs(z - WATERFALL.z);
      if (dz < 2.4 && x > WATERFALL.x - 12 && x < WATERFALL.x) h = Math.min(h, WATERFALL.lip); // canal do rio no alto
      if (x >= WATERFALL.x && dz < 4.2) h *= THREE.MathUtils.smoothstep(dz, 2.6, 4.2);           // garganta da queda
      return Math.max(0, h);
    }
    function mountainH(x, z) {
      if (Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z) > MOUNTAIN.r + 14) return 0;
      let h = mountainBase(x, z);
      const C = RALLY_SIDE + 1.2;
      // Para cada passagem, só o ponto mais próximo dela conta (altura interpolada ao longo da estrada):
      // assim o aterro de um trecho mais alto não enterra o trecho vizinho mais baixo da mesma rampa
      for (let g = 0; g < mountainPasses.length; g++) {
        const pass = mountainPasses[g];
        let best = null, bd = 1e9;
        for (let i = 0; i < pass.length; i++) {
          const s = pass[i], dx = x - s.x, dz = z - s.z, d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = s; }
        }
        if (bd > (C + 16) * (C + 16)) continue;
        const along = (x - best.x) * best.tx + (z - best.z) * best.tz;
        const nb = rallySamples[(best.i + (along >= 0 ? 1 : -1) + RALLY_N) % RALLY_N];
        const ry = best.y + (nb.y - best.y) * Math.min(1, Math.abs(along) / RALLY_STEP);
        const lat = Math.abs((x - best.x) * (-best.tz) + (z - best.z) * best.tx);
        const k = Math.max(0, lat - C) * 0.95;
        h = Math.min(Math.max(h, ry - 0.25 - k), ry - 0.25 + k); // aterro/corte acompanhando a estrada
      }
      return Math.max(0, h);
    }
    const RALLY_SIDE = RALLY_W / 2, RALLY_FADE = 1.2;
    function rallyProfile(o, s, du) {
      switch (o.kind) {
        case 'kicker': {
          const lip = 0.55;
          if (s > lip) return 0;
          return o.h * Math.pow((s + 1) / (1 + lip), 1.35);
        }
        case 'hill': return o.h * (0.5 + 0.5 * Math.cos(Math.PI * s));
        case 'whoops': return o.h * 0.5 * (1 - Math.cos(Math.PI * 4 * (s + 1)));
        case 'logs': {
          const R = 0.72;
          let hh = 1.75 * Math.max(0, 1 - Math.abs(du) / o.half); // rampas de terra dos dois lados
          [[-R, R], [R, R], [0, R + R * 1.732]].forEach(([cx, cy]) => {
            const q = R * R - (du - cx) * (du - cx);
            if (q > 0) hh = Math.max(hh, cy + Math.sqrt(q));
          });
          return hh;
        }
        case 'rocks': {
          const ss = THREE.MathUtils.smoothstep;
          const v = 0.7 * (ss(s, -0.84, -0.76) + ss(s, -0.49, -0.41) + ss(s, -0.14, -0.06))
            - 0.8 * ss(s, 0.31, 0.39) - 0.7 * ss(s, 0.66, 0.74) - 0.6 * ss(s, 0.88, 0.96);
          return Math.max(0, v) * (o.h / 2.1);
        }
        case 'tires':
          return o.h * (0.6 * (0.5 + 0.5 * Math.cos(Math.PI * s)) + 0.4 * Math.abs(Math.sin(Math.PI * 1.5 * (s + 1))) * (1 - Math.abs(s)));
      }
      return 0;
    }
    function rallyObstacleHeight(o, du, dv) {
      if (Math.abs(du) > o.half) return 0;
      const av = Math.abs(dv);
      if (av > RALLY_SIDE + RALLY_FADE) return 0;
      const side = av <= RALLY_SIDE ? 1 : 1 - THREE.MathUtils.smoothstep(av, RALLY_SIDE, RALLY_SIDE + RALLY_FADE);
      return rallyProfile(o, du / o.half, du) * side;
    }
    function rallyObstacleAt(x, z) {
      let best = null, bh = 0;
      for (let i = 0; i < RALLY_OBSTACLES.length; i++) {
        const o = RALLY_OBSTACLES[i];
        const dx = x - o.cx, dz = z - o.cz;
        if (dx * dx + dz * dz > o.reach * o.reach) continue;
        const h = rallyObstacleHeight(o, dx * o.tx + dz * o.tz, dx * (-o.tz) + dz * o.tx);
        if (h > bh) { bh = h; best = o; }
      }
      return best ? { h: bh, o: best } : null;
    }
    function rallyHeightAt(x, z) {
      if (x < 128) return 0;
      const r = rallyObstacleAt(x, z);
      return r ? r.h : 0;
    }
    function rallyMudAt(x, z) {
      if (x < 128) return null;
      const q = rallyNearest(x, z);
      if (Math.abs(q.lat) > RALLY_SIDE + 0.3) return null;
      return RALLY_MUD.some(([a, b]) => q.t >= a && q.t <= b) ? q : null;
    }

    const bajaIsland = IS_QUINTAL && createIsland({
      id: 'baja',
      name: 'Projeto Baja SAE · Thiago Ribeiro',
      label: 'Baja SAE · Thiago',
      x: 185, z: 64, r: 12, point: [185, 55],
      text: 'Carro Baja 13 da equipe Piratas do Vale (Unesp), modelado a partir das fotos reais! Ele é um carro de rally: não tem mangueira nem sirene, mas é o único que acelera na lama e sobe troncos, pedras, morro e pneus da pista off-road. Estacione na base verde para recarregar a bateria.',
      actions: [
        { label: '🏎️ Dirigir o Baja 13 na pista de rally', run: () => switchVehicleModel('baja') },
        { label: '🚒 Voltar para o caminhãozinho do Ravi', run: () => switchVehicleModel('truck') },
        { label: '🏴‍☠️ Site do Projeto Baja · Piratas do Vale ↗', run: () => openExternal('https://piratasdovalepcp.netlify.app') }
      ]
    });

    // Posto de recarga do Baja (na ilha dele): base verde pulsante + totem com raio e cabo
    const BAJA_CHARGER = { x: 175, z: 62, r: 3.6 };
    const bajaCharger = !IS_QUINTAL ? null : (() => {
      const g = new THREE.Group();
      g.position.set(BAJA_CHARGER.x, ISLAND_Y, BAJA_CHARGER.z);
      const padMat = new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0.55, depthWrite: false });
      const pad = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.4, 40), padMat);
      pad.rotation.x = -Math.PI / 2; pad.position.y = 0.06;
      const padFill = new THREE.Mesh(new THREE.CircleGeometry(2.6, 40), new THREE.MeshStandardMaterial({ color: 0x1f2a22, roughness: 0.6 }));
      padFill.rotation.x = -Math.PI / 2; padFill.position.y = 0.05;
      const bolt = new THREE.Shape();
      [[0.2, 1.4], [-0.7, -0.1], [-0.05, -0.1], [-0.3, -1.4], [0.7, 0.2], [0.05, 0.2]].forEach(([x, y], i) => (i ? bolt.lineTo(x, y) : bolt.moveTo(x, y)));
      const boltMesh = new THREE.Mesh(new THREE.ShapeGeometry(bolt), new THREE.MeshBasicMaterial({ color: 0xd5ff95 }));
      boltMesh.rotation.x = -Math.PI / 2; boltMesh.position.y = 0.08; boltMesh.scale.setScalar(1.1);
      // Totem do carregador
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.45, metalness: 0.35 });
      const totem = new THREE.Mesh(new THREE.BoxGeometry(1.3, 4.2, 0.9), bodyMat);
      totem.position.set(-4.2, 2.1, 0); totem.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 1.1), new THREE.MeshStandardMaterial({ color: 0x7ee787, roughness: 0.4 }));
      cap.position.set(-4.2, 4.35, 0);
      const screenMat = new THREE.MeshBasicMaterial({ color: 0x7ee787 });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.2), screenMat);
      screen.position.set(-4.2, 2.9, 0.46);
      const icon = new THREE.Mesh(new THREE.ShapeGeometry(bolt), new THREE.MeshBasicMaterial({ color: 0x1f2a22 }));
      icon.scale.setScalar(0.32); icon.position.set(-4.2, 2.9, 0.47);
      const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(-3.6, 2.2, 0.3), new THREE.Vector3(-3.0, 1.0, 0.8), new THREE.Vector3(-2.6, 0.2, 0.4), new THREE.Vector3(-2.2, 0.15, 0)
      ]), 16, 0.09, 6, false), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.7 }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlowTexture, color: 0x7ee787, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.set(0, 0.6, 0); glow.scale.set(7, 2, 1);
      g.add(padFill, pad, boltMesh, totem, cap, screen, icon, cable, glow);
      scene.add(g);
      obstacles.push({ x: BAJA_CHARGER.x - 4.2, z: BAJA_CHARGER.z, r: 1.0, box: { hx: 0.65, hz: 0.45 }, boxRot: 0, h: 4.4, name: 'CARREGADOR DO BAJA', isStatic: true, level: 'floor' });
      createIslandLabel('Recarga do Baja ⚡', BAJA_CHARGER.x - 2, ISLAND_Y + 7, BAJA_CHARGER.z).scale.set(9, 1.8, 1);
      return { pad, padMat, screenMat, glow, boltMesh, charging: false };
    })();
    function updateBajaCharger(time) {
      if (!bajaCharger) return;
      const c = bajaCharger;
      const k = c.charging ? 0.5 + 0.5 * Math.sin(time * 8) : 0.5 + 0.5 * Math.sin(time * 2);
      c.padMat.opacity = 0.35 + k * (c.charging ? 0.6 : 0.3);
      c.glow.material.opacity = (c.charging ? 0.5 : 0.25) + k * 0.3;
      c.screenMat.color.setHex(c.charging ? (Math.floor(time * 4) % 2 ? 0xd5ff95 : 0x7ee787) : 0x7ee787);
      c.boltMesh.rotation.z = c.charging ? time * 2 : 0;
    }

    IS_QUINTAL && (function buildBajaRallyTrack() {
      const Y0 = FLOOR_SURFACE_Y;
      const col = new THREE.Color();
      // 1. Faixa de terra batida avermelhada (como nas fotos), com sulcos de pneu e bermas nas bordas
      const cross = [-RALLY_SIDE - 1.8, -RALLY_SIDE - 0.8, -RALLY_SIDE, -2.8, -2.2, -1.6, 0, 1.6, 2.2, 2.8, RALLY_SIDE, RALLY_SIDE + 0.8, RALLY_SIDE + 1.8];
      const crossH = [0, 0.22, 0.02, 0, -0.02, 0, 0, 0, -0.02, 0, 0.02, 0.22, 0];
      const crossC = [0x7e8b3c, 0x9c6236, 0xa9653a, 0xb36a3c, 0x8b4b29, 0xb36a3c, 0xbb7343, 0xb36a3c, 0x8b4b29, 0xb36a3c, 0xa9653a, 0x9c6236, 0x7e8b3c];
      const pos = [], cols = [], idx = [];
      const NC = cross.length;
      for (let i = 0; i < RALLY_N; i++) {
        const s = rallySamples[i], nx = -s.tz, nz = s.tx;
        const elev = s.y > 0.25;
        const onBridge = elev && Math.abs(i - RALLY_CROSSINGS[0].over) * RALLY_STEP < RALLY_CROSSINGS[0].Lh;
        for (let k = 0; k < NC; k++) {
          let v = cross[k] + (k === 0 || k === NC - 1 ? Math.sin(i * 0.7) * 0.5 : 0);
          if (elev) v = clamp(v, -RALLY_SIDE, RALLY_SIDE); // elevado: sem bermas, a pista termina na borda
          pos.push(s.x + nx * v, Y0 + 0.05 + s.y + (elev ? 0 : crossH[k]), s.z + nz * v);
          if (onBridge) col.setHex(i % 2 ? 0xa0703f : 0x8a5c31); // tábuas da ponte
          else col.setHex(crossC[k]);
          col.multiplyScalar(0.9 + Math.random() * 0.18).convertSRGBToLinear();
          cols.push(col.r, col.g, col.b);
        }
      }
      for (let i = 0; i < RALLY_N; i++) {
        const a = i * NC, b = ((i + 1) % RALLY_N) * NC;
        for (let k = 0; k < NC - 1; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
      const dirtGeo = new THREE.BufferGeometry();
      dirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      dirtGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      dirtGeo.setIndex(idx);
      dirtGeo.computeVertexNormals();
      const dirt = new THREE.Mesh(dirtGeo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.96, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      dirt.receiveShadow = true;
      bedroomWorld.add(dirt);

      // 2. Lamaçais: faixas de lama brilhante com bordas irregulares e poças d'água refletindo
      // Lama em shader (mesma ideia da água, mas pesada): escorre devagar, poças de água barrenta
      // refletindo o céu, brilho molhado, sulcos de pneu, bolhas estourando e borda irregular úmida
      const mudMat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        uniforms: {
          uTime: worldUniforms.uTime,
          uDark: { value: new THREE.Color(0x2a170b) },
          uLight: { value: new THREE.Color(0x74492a) },
          uSky: { value: new THREE.Color(0xd7ecf6) }
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vW;
          void main() {
            vUv = uv;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: `
          uniform float uTime;
          uniform vec3 uDark;
          uniform vec3 uLight;
          uniform vec3 uSky;
          varying vec2 vUv;
          varying vec3 vW;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
          }
          float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
          void main() {
            vec2 p = vW.xz * 0.32;
            vec2 drift = vec2(uTime * 0.018, uTime * 0.012);       // lama: movimento bem lento
            float n = fbm(p + drift);
            float lat = abs(vUv.x / 1.2);
            float border = lat + (fbm(vW.xz * 0.45) - 0.5) * 0.4;
            if (border > 0.98) discard;                              // borda recortada, sem polígono reto
            vec3 col = mix(uDark, uLight, smoothstep(0.28, 0.82, n));
            float rut = smoothstep(0.09, 0.0, abs(lat - 0.36));      // sulcos das rodas
            col *= 1.0 - rut * 0.4;
            // Poças de água barrenta nas partes baixas
            float pud = smoothstep(0.43, 0.33, n) * (1.0 - smoothstep(0.7, 0.95, border));
            float rip = sin(p.x * 7.0 + uTime * 0.9) * sin(p.y * 6.0 - uTime * 0.7);
            vec3 water = mix(uDark * 1.1, uSky * 0.42, 0.3 + 0.1 * rip);
            col = mix(col, water, pud * 0.85);
            // Brilho molhado: normal tirada do relevo do ruído
            float e = 0.12;
            float gx = fbm(p + drift + vec2(e, 0.0)) - n, gz = fbm(p + drift + vec2(0.0, e)) - n;
            vec3 nrm = normalize(vec3(-gx * 7.0, 1.0, -gz * 7.0));
            vec3 V = normalize(cameraPosition - vW);
            vec3 L = normalize(vec3(0.45, 0.8, 0.35));
            float spec = pow(max(dot(reflect(-L, nrm), V), 0.0), 36.0);
            float specPud = pow(max(dot(reflect(-L, vec3(0.0, 1.0, 0.0)), V), 0.0), 90.0);
            col += spec * 0.35 + specPud * pud * 0.7;
            // Bolhas que crescem e estouram
            vec2 cp = vW.xz * 1.5;
            vec2 cell = floor(cp), f = fract(cp) - 0.5;
            float h = hash(cell);
            float ph = fract(uTime * 0.22 + h * 7.0);
            vec2 c = (vec2(hash(cell + 3.1), hash(cell + 5.7)) - 0.5) * 0.5;
            float ring = smoothstep(0.03, 0.0, abs(length(f - c) - (0.04 + ph * 0.12)));
            col += ring * step(0.9, h) * (1.0 - ph) * 0.3;
            col *= 1.0 - smoothstep(0.65, 0.97, border) * 0.4;       // borda mais escura e úmida
            gl_FragColor = vec4(col, 1.0);
          }`
      });
      withFog(mudMat);
      RALLY_MUD.forEach(([t0, t1]) => {
        const i0 = Math.round(t0 * RALLY_N), i1 = Math.round(t1 * RALLY_N);
        const mp = [], muv = [], mi = [];
        const L = 7;
        let row = 0;
        for (let i = i0; i <= i1; i++, row++) {
          const s = rallySamples[i % RALLY_N], nx = -s.tz, nz = s.tx;
          const endFade = Math.min(1, (i - i0) / 6, (i1 - i) / 6);
          for (let k = 0; k < L; k++) {
            const f = k / (L - 1) * 2 - 1;
            const w = (RALLY_SIDE - 0.3 + Math.sin(i * 0.9 + k) * 0.6) * (0.45 + 0.55 * endFade);
            mp.push(s.x + nx * f * w, Y0 + 0.09, s.z + nz * f * w);
            muv.push(f * 1.2, row * 0.18);
          }
        }
        for (let r = 0; r < row - 1; r++) for (let k = 0; k < L - 1; k++) {
          const a = r * L + k, b = (r + 1) * L + k;
          mi.push(a, b, a + 1, a + 1, b, b + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(muv, 2));
        g.setIndex(mi);
        g.computeVertexNormals();
        const mud = new THREE.Mesh(g, mudMat);
        mud.receiveShadow = true;
        bedroomWorld.add(mud);
        // (as poças agora fazem parte do shader da lama)
      });

      // 3. Obstáculos: malha gerada pela mesma função de altura da física
      const obsMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.93, flatShading: true });
      const barkMat = new THREE.MeshStandardMaterial({ color: 0x5a381e, roughness: 0.9 });
      const cutMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.7 });
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.85, flatShading: true });
      const tireMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.9 });
      const flagMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, side: THREE.DoubleSide });
      const poleMat = new THREE.MeshStandardMaterial({ color: 0xf4f1de, roughness: 0.5 });
      const toWorld = (o, du, dv, y) => new THREE.Vector3(o.cx + o.tx * du - o.tz * dv, y, o.cz + o.tz * du + o.tx * dv);
      RALLY_OBSTACLES.forEach((o) => {
        const segU = Math.ceil(o.len * 3), segV = 16, halfV = RALLY_SIDE + RALLY_FADE;
        const p = [], c = [], ix = [];
        for (let iu = 0; iu <= segU; iu++) {
          const du = -o.half + o.len * iu / segU;
          for (let iv = 0; iv <= segV; iv++) {
            const dv = -halfV + 2 * halfV * iv / segV;
            const h = rallyObstacleHeight(o, du, dv);
            const w = toWorld(o, du, dv, Y0 + 0.07 + h);
            p.push(w.x, w.y, w.z);
            if (o.kind === 'kicker' && Math.abs(dv) < RALLY_SIDE - 0.6 && h > 0.05) col.setHex(Math.floor((du + o.half) * 1.6) % 2 ? 0xa0703f : 0x8a5c31); // tábuas da rampa
            else col.setHex(0xb36a3c).lerp(new THREE.Color(0xd08a55), Math.min(1, h / (o.h + 0.01)) * 0.5);
            col.multiplyScalar(0.88 + Math.random() * 0.2).convertSRGBToLinear();
            c.push(col.r, col.g, col.b);
          }
        }
        for (let iu = 0; iu < segU; iu++) for (let iv = 0; iv < segV; iv++) {
          const a = iu * (segV + 1) + iv, b = (iu + 1) * (segV + 1) + iv;
          ix.push(a, a + 1, b, a + 1, b + 1, b);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
        g.setIndex(ix);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, obsMat);
        m.castShadow = true; m.receiveShadow = true;
        bedroomWorld.add(m);

        const along = Math.atan2(o.tx, o.tz);
        if (o.kind === 'logs') {
          const R = 0.72;
          [[-R, R], [R, R], [0, R + R * 1.732]].forEach(([cx, cy]) => {
            const lg = new THREE.Group();
            const trunk = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.05, RALLY_W + 1.4, 14), barkMat);
            trunk.rotation.z = Math.PI / 2;
            trunk.castShadow = true;
            lg.add(trunk);
            [-1, 1].forEach((e) => {
              const cut = new THREE.Mesh(new THREE.CircleGeometry(R * 0.95, 14), cutMat);
              cut.rotation.y = e * Math.PI / 2; cut.position.x = e * (RALLY_W + 1.4) / 2 + e * 0.01;
              lg.add(cut);
            });
            lg.position.copy(toWorld(o, cx, 0, Y0 + 0.07 + cy));
            lg.rotation.y = along;
            bedroomWorld.add(lg);
          });
        } else if (o.kind === 'tires') {
          const tires = new THREE.InstancedMesh(new THREE.TorusGeometry(0.75, 0.32, 8, 16), tireMat, 18);
          const d = new THREE.Object3D();
          for (let i = 0; i < 18; i++) {
            const du = -o.half * 0.8 + (i % 6) * (o.len * 0.8 / 5), dv = (Math.floor(i / 6) - 1) * 3.6 + ((i % 2) ? 0.8 : -0.8);
            const h = rallyObstacleHeight(o, du, dv);
            d.position.copy(toWorld(o, du, dv, Y0 + 0.07 + h - 0.12));
            d.rotation.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.3, 0, Math.random() * 3);
            d.updateMatrix();
            tires.setMatrixAt(i, d.matrix);
          }
          tires.castShadow = true;
          bedroomWorld.add(tires);
        } else if (o.kind === 'rocks') {
          for (let i = 0; i < 16; i++) {
            const du = -o.half + Math.random() * o.len, side = i % 2 ? 1 : -1;
            const r = 0.7 + Math.random() * 0.9;
            const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMat);
            rock.scale.set(1.3, 0.8 + Math.random() * 0.5, 1.1);
            rock.rotation.set(Math.random(), Math.random() * 3, Math.random());
            const dv = side * (RALLY_SIDE + 0.4 + Math.random() * 0.8);
            rock.position.copy(toWorld(o, du, dv, Y0 + rallyObstacleHeight(o, du, side * (RALLY_SIDE - 0.2)) * 0.7 + 0.2));
            rock.castShadow = true;
            bedroomWorld.add(rock);
          }
          // Pedras chatas embutidas na superfície (não passam da altura física)
          for (let i = 0; i < 10; i++) {
            const du = -o.half + Math.random() * o.len, dv = (Math.random() - 0.5) * (RALLY_W - 2);
            const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8 + Math.random() * 0.6, 0), rockMat);
            rock.scale.set(1.4, 0.35, 1.2);
            rock.position.copy(toWorld(o, du, dv, Y0 + 0.07 + rallyObstacleHeight(o, du, dv) - 0.12));
            bedroomWorld.add(rock);
          }
        } else if (o.kind === 'hill') {
          const pts = [];
          for (let i = 0; i < 260; i++) {
            const du = (Math.random() - 0.5) * o.len * 0.9, dv = (Math.random() > 0.5 ? 1 : -1) * (RALLY_SIDE - 0.5 + Math.random() * 1.6);
            const w = toWorld(o, du, dv, Y0 + 0.07 + rallyObstacleHeight(o, du, dv));
            pts.push({ x: w.x, y: w.y, z: w.z, h: 0.5 + Math.random() * 0.8 });
          }
          createGrassPatch(pts);
        }
        // Balizas com bandeirinha laranja na entrada de cada obstáculo
        [-1, 1].forEach((side) => {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 6), poleMat);
          const base = toWorld(o, -o.half, side * (RALLY_SIDE + 1.9), Y0 + 1.6);
          pole.position.copy(base);
          const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), flagMat);
          flag.position.set(base.x, Y0 + 2.8, base.z);
          flag.rotation.y = along;
          flag.translateX(0.55);
          bedroomWorld.add(pole, flag);
          rallyFlags.push(flag);
        });
        o.label = createIslandLabel(o.name, o.cx, Y0 + o.h + 5.5, o.cz);
        o.label.scale.set(9, 1.8, 1);
      });

      // 4. Largada: portal com faixa e linha quadriculada
      {
        const s = rallySampleAt(0);
        const nx = -s.tz, nz = s.tx;
        const chk = document.createElement('canvas'); chk.width = 256; chk.height = 32;
        const cx = chk.getContext('2d');
        for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = (i + j) % 2 ? '#111' : '#fff'; cx.fillRect(i * 16, j * 16, 16, 16); }
        const line = new THREE.Mesh(new THREE.PlaneGeometry(RALLY_W, 1.4), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(chk), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
        line.rotation.x = -Math.PI / 2;
        line.rotation.z = Math.atan2(s.tx, s.tz) + Math.PI / 2;
        line.position.set(s.x, Y0 + 0.1, s.z);
        bedroomWorld.add(line);
        const postMat = new THREE.MeshStandardMaterial({ color: 0x2f55c8, roughness: 0.4, metalness: 0.4 });
        [-1, 1].forEach((side) => {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 8, 10), postMat);
          post.position.set(s.x + nx * side * (RALLY_SIDE + 1.4), Y0 + 4, s.z + nz * side * (RALLY_SIDE + 1.4));
          // (o visual agora é o pórtico da Kenney; aqui só fica a colisão das pernas)
          obstacles.push({ x: post.position.x, z: post.position.z, r: 0.5, h: 8, name: 'PORTAL DA LARGADA', isStatic: true, level: 'floor' });
        });
        const bc = document.createElement('canvas'); bc.width = 1024; bc.height = 160;
        const b = bc.getContext('2d');
        b.fillStyle = '#111317'; b.fillRect(0, 0, 1024, 160);
        for (let i = 0; i < 64; i++) { b.fillStyle = i % 2 ? '#fff' : '#111'; b.fillRect(i * 16, 0, 16, 16); b.fillStyle = i % 2 ? '#111' : '#fff'; b.fillRect(i * 16, 144, 16, 16); }
        b.fillStyle = '#ffb703'; b.font = 'bold 82px "Amatic SC", sans-serif'; b.textAlign = 'center'; b.textBaseline = 'middle';
        b.fillText('RALLY BAJA · PIRATAS DO VALE', 512, 82);
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(RALLY_W + 3, 2.2), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(bc), roughness: 0.6, side: THREE.DoubleSide }));
        banner.position.set(s.x, Y0 + 7, s.z);
        banner.rotation.y = Math.atan2(s.tx, s.tz);
        // (a faixa antiga saiu: o pórtico da Kenney com luzes faz o papel de largada)
      }

      // 6. Pneus de proteção: pilhas soltas e PESADAS (o carrinho só consegue tirar do lugar com turbo/nitro)
      const nearTunnel = (t) => RALLY_TUNNELS.some((tn) => Math.abs(tn.t - t) < 0.035);
      const tireRed = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.8 });
      const tireWhite = new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.8 });
      // Pilha de pneus = UMA malha (3 toros juntos com cor por vértice): 1 chamada de desenho em vez de 3
      const tireStackMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
      const tireStackGeos = [0, 1, 2, 3].map((variant) => {
        const pos = [], nrm = [], col = [], idx = [];
        const cRed = new THREE.Color(0xc8102e).convertSRGBToLinear(), cWhite = new THREE.Color(0xf1f1ef).convertSRGBToLinear(), cBlack = new THREE.Color(0x1b1e23).convertSRGBToLinear();
        for (let k = 0; k < 3; k++) {
          const t = new THREE.TorusGeometry(0.95, 0.42, 8, 18);
          t.rotateX(-Math.PI / 2); t.rotateY(k * 1.1 + variant); t.translate((k - 1) * 0.04, 0.42 + k * 0.8, 0);
          const c = k === 1 ? cBlack : ((variant + k) % 2 ? cRed : cWhite);
          const base = pos.length / 3;
          pos.push(...t.attributes.position.array); nrm.push(...t.attributes.normal.array);
          for (let i = 0; i < t.attributes.position.count; i++) col.push(c.r, c.g, c.b);
          t.index.array.forEach((v) => idx.push(v + base));
          t.dispose();
        }
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g2.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        g2.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g2.setIndex(idx);
        g2.computeBoundingSphere();
        return g2;
      });
      let tireVariant = 0;
      function tireStack(x, z) {
        const g = new THREE.Group();
        g.position.set(x, Y0, z);
        const mesh = new THREE.Mesh(tireStackGeos[tireVariant++ % 4], tireStackMat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        g.add(mesh);
        bedroomWorld.add(g);
        const o = registerDynamicObstacle({ obs: { x, z, r: 1.4, h: 2.4, name: 'PILHA DE PNEUS' }, group: g, mass: 4.5, canTopple: true });
        o.heavy = true; o.friction = 0.8; o.restitution = 0.15;
        return o;
      }
      for (let i = 0; i < RALLY_N; i += 13) {
        const s0 = rallySamples[i], s1 = rallySamples[(i + 6) % RALLY_N];
        if (nearTunnel(s0.t)) continue;
        // lado de fora da curva (para onde o carrinho escapa); nas retas alterna os lados
        const turn = s0.tx * s1.tz - s0.tz * s1.tx;
        const side = Math.abs(turn) > 0.02 ? (turn > 0 ? 1 : -1) : ((i / 13) % 2 ? 1 : -1);
        for (const off of Math.abs(turn) > 0.05 ? [-1.6, 1.6] : [0]) {
          const lat = side * (RALLY_SIDE + 1.6);
          const x = s0.x - s0.tz * lat + s0.tx * off, z = s0.z + s0.tx * lat + s0.tz * off;
          if (rallyObstacleAt(x, z) || rallyNearest(x, z).dist < RALLY_SIDE + 0.6 || s0.y > 0.1 || mountainH(x, z) > 0.2) continue;
          if (RALLY_CROSSINGS.some((c) => Math.hypot(x - c.x, z - c.z) < 16) || Math.hypot(x - POND.x, z - POND.z) < POND.r + 2) continue;
          if (Math.hypot(x - 185, z - 64) < 14 || Math.hypot(x - 152, z - 70) < 13) continue;
          tireStack(x, z);
        }
      }
      [0.09, 0.19, 0.33, 0.41, 0.49, 0.62, 0.67, 0.78, 0.86, 0.95].forEach((t, i) => {
        if (nearTunnel(t)) return;
        const s = rallySampleAt(t), side = i % 2 ? 1 : -1;
        const x = s.x - s.tz * side * (RALLY_SIDE + 0.6), z = s.z + s.tx * side * (RALLY_SIDE + 0.6);
        if (rallyObstacleAt(x, z) || s.y > 0.1 || mountainH(x, z) > 0.2) return;
        placeModel(i % 2 ? 'traffic_cone_01' : 'traffic_cone_02', { x, z, floor: true, name: 'Cone do Rally' });
      });
    })();

    // ---------------------------------------------------------------------------
    // Túneis, cachoeira, itens empurráveis, poeira e muito verde em volta da pista do rally
    // ---------------------------------------------------------------------------
    const rallyFx = { dust: [], mist: [] };
    IS_QUINTAL && (function buildRallyExtras() {
      const Y0 = FLOOR_SURFACE_Y;
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d7a72, roughness: 0.9, flatShading: true });
      const mossMat = new THREE.MeshStandardMaterial({ color: 0x4a7230, roughness: 0.95, flatShading: true });
      // 1. Túneis de pedra coberta de grama (o carrinho passa por baixo)
      // Cada túnel é feito de gomos curtos que seguem as amostras da pista (funciona também nas curvas)
      const rallyLen = rallyCurve.getLength();
      const innerMat = new THREE.MeshStandardMaterial({ color: 0x55524c, roughness: 0.95, side: THREE.BackSide, flatShading: true });
      RALLY_TUNNELS.forEach((tn) => {
        const R = RALLY_SIDE + 1.4;
        const span = Math.ceil((tn.len / rallyLen) * RALLY_N / 2);
        const i0 = Math.round(tn.t * RALLY_N);
        const step = rallyLen / RALLY_N;
        const innerGeo = new THREE.CylinderGeometry(R, R, step * 1.25, 24, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
        const outerGeo = new THREE.CylinderGeometry(R + 2.5, R + 2.7, step * 1.25, 16, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
        const grassPts = [];
        for (let k = -span; k <= span; k++) {
          const sm = rallySamples[((i0 + k) % RALLY_N + RALLY_N) % RALLY_N];
          const yaw = Math.atan2(sm.tx, sm.tz);
          const seg = new THREE.Group();
          seg.position.set(sm.x, Y0, sm.z);
          seg.rotation.y = yaw;
          const inner = new THREE.Mesh(innerGeo, innerMat);
          const outer = new THREE.Mesh(outerGeo, mossMat);
          outer.castShadow = true; outer.receiveShadow = true;
          outer.scale.set(1 + Math.sin(k * 1.7) * 0.04, 1 + Math.sin(k * 2.3) * 0.05, 1);
          seg.add(inner, outer);
          if (Math.abs(k) === span) {
            const e = k > 0 ? 1 : -1;
            const ring = new THREE.Mesh(new THREE.RingGeometry(R, R + 2.7, 20, 1, 0, Math.PI), rockMat);
            ring.position.z = e * step * 0.6;
            ring.rotation.y = e > 0 ? 0 : Math.PI;
            seg.add(ring);
            for (let j = 0; j < 7; j++) {
              const aa = (j / 6) * Math.PI;
              const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9 + Math.random() * 0.5, 0), rockMat);
              rk.position.set(Math.cos(aa) * (R + 1.3), Math.sin(aa) * (R + 1.3), e * (step * 0.6 + 0.2));
              rk.castShadow = true;
              seg.add(rk);
            }
          }
          if (k === 0 || Math.abs(k) === Math.floor(span / 2)) {
            const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd37a }));
            lamp.position.set(0, R - 0.45, 0);
            seg.add(lamp);
          }
          if (k === 0) { // brilho falso no teto do túnel (sem luz real)
            const tg = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlowTexture, color: 0xffc06a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
            tg.position.set(0, R - 1.2, 0);
            tg.scale.setScalar(6);
            seg.add(tg);
          }
          scene.add(seg);
          // Paredes de colisão nas laterais, sempre a partir do traçado real
          // (no túnel da montanha não: ali a casca fica enterrada no morro e os colisores viravam "paredes invisíveis"
          //  para quem subia pela encosta — o próprio corte do terreno já segura o carrinho)
          if (k % 2 === 0 && !tn.mountain) {
            [-1, 1].forEach((side) => {
              const lx = side * (R + 1.3);
              obstacles.push({ x: sm.x - sm.tz * lx, z: sm.z + sm.tx * lx, r: 1.2, h: 9, name: 'PAREDE DO TÚNEL', isStatic: true, level: 'floor' });
            });
          }
          for (let j = 0; j < 22; j++) {
            const aa = 0.25 + Math.random() * (Math.PI - 0.5), r = R + 2.6;
            const lx = Math.cos(aa) * r, ly = Math.sin(aa) * r, zz = (Math.random() - 0.5) * step;
            grassPts.push({ x: sm.x + sm.tx * zz - sm.tz * lx, y: Y0 + ly, z: sm.z + sm.tz * zz + sm.tx * lx, h: 0.5 + Math.random() * 0.9 });
          }
        }
        if (!tn.mountain) {
          createGrassPatch(grassPts);
          const mid = rallySamples[i0 % RALLY_N];
          createBush(mid.x, mid.z, Y0 + R + 2.1, 0.6, 0);
          obstacles.pop(); // moita decorativa no teto: sem colisão no chão da pista
        }
      });

      // 2. Montanha da cachoeira (terreno), queda d'água, ponte alta de madeira e lago do miolo
      {
        const M = MOUNTAIN, S = 74, span = (M.r + 14) * 2;
        const mp = [], mc = [], mi = [];
        for (let iz = 0; iz <= S; iz++) for (let ix = 0; ix <= S; ix++) {
          const x = M.x - span / 2 + span * ix / S, z = M.z - span / 2 + span * iz / S;
          const h = mountainH(x, z);
          mp.push(x, h > 0.03 ? Y0 + h : Y0 - 0.6, z);
        }
        for (let iz = 0; iz < S; iz++) for (let ix = 0; ix < S; ix++) {
          const a = iz * (S + 1) + ix, b = a + S + 1;
          mi.push(a, b, a + 1, a + 1, b, b + 1);
        }
        const mg = new THREE.BufferGeometry();
        mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
        mg.setIndex(mi);
        const flat = mg.toNonIndexed();
        flat.computeVertexNormals();
        const nrm = flat.attributes.normal, fp = flat.attributes.position;
        const grass = new THREE.Color(0x6aa84f), grass2 = new THREE.Color(0x8cc265), rock = new THREE.Color(0x8d877c), rock2 = new THREE.Color(0x6f6a61), cc = new THREE.Color();
        for (let i = 0; i < fp.count; i += 3) {
          const ny = (nrm.getY(i) + nrm.getY(i + 1) + nrm.getY(i + 2)) / 3;
          const hy = (fp.getY(i) + fp.getY(i + 1) + fp.getY(i + 2)) / 3 - Y0;
          if (ny < 0.72) cc.copy(Math.random() > 0.5 ? rock : rock2);
          else cc.copy(grass).lerp(grass2, Math.min(1, hy / M.h) * 0.7 + Math.random() * 0.15);
          cc.convertSRGBToLinear();
          for (let k = 0; k < 3; k++) mc.push(cc.r, cc.g, cc.b);
        }
        flat.setAttribute('color', new THREE.Float32BufferAttribute(mc, 3));
        const mountain = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
        mountain.castShadow = true; mountain.receiveShadow = true;
        bedroomWorld.add(mountain);
        // Pedras, árvores e capim sobre a montanha (longe das estradas e da água)
        const clearOfRoads = (x, z, pad) => rallyNearest(x, z).dist > RALLY_SIDE + pad;
        let placedR = 0, placedT = 0;
        for (let n = 0; n < 1600 && (placedR < 40 || placedT < 12); n++) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * (M.r - 3);
          const x = M.x + Math.cos(a) * r, z = M.z + Math.sin(a) * r;
          const h = mountainH(x, z);
          if (h < 1.5 || !clearOfRoads(x, z, 3.5) || (Math.abs(z - WATERFALL.z) < 5 && x > WATERFALL.x - 13)) continue;
          if (placedR < 40 && (n % 2 === 0 || placedT >= 12)) {
            const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 + Math.random() * 1.4, 0), rockMat);
            rk.position.set(x, Y0 + h - 0.2, z);
            rk.scale.set(1.2, 0.7 + Math.random() * 0.5, 1);
            rk.rotation.set(Math.random(), Math.random() * 3, Math.random());
            rk.castShadow = true;
            bedroomWorld.add(rk);
            placedR++;
          } else if (placedT < 12 && clearOfRoads(x, z, 4.5)) {
            createTree(x, z, Y0 + h - 0.1, 0.6 + Math.random() * 0.3, placedT % 3);
            obstacles.pop(); // árvore no alto do morro: sem colisão no nível do chão
            placedT++;
          }
        }
        const mpts = [];
        for (let n = 0; n < 2600; n++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (M.r - 1);
          const x = M.x + Math.cos(a) * r, z = M.z + Math.sin(a) * r;
          const h = mountainH(x, z);
          if (h < 0.4 || !clearOfRoads(x, z, 1.2)) continue;
          mpts.push({ x, y: Y0 + h, z, h: 0.4 + Math.random() * 0.8 });
        }
        createGrassPatch(mpts);

        // Rio no alto do morro, queda d'água na garganta, piscina com névoa e pedras
        const W = WATERFALL;
        const river = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.6, 6, 2), createWaterMaterial({ shallow: 0x9fe8f0, deep: 0x3aa6c8, scale: 1.6, flow: [-2.8, 0] }));
        river.geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(Array.from({ length: river.geometry.attributes.position.count }, (_, i) => Math.abs(river.geometry.attributes.position.getY(i)) / 2.3 * 0.9), 1));
        river.material.side = THREE.DoubleSide;
        river.rotation.x = -Math.PI / 2;
        river.position.set(W.x - 6, Y0 + W.lip + 0.08, W.z);
        river.renderOrder = 3;
        scene.add(river);
        const fallMat = new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          uniforms: { uTime: worldUniforms.uTime },
          vertexShader: `
            varying vec2 vUv;
            uniform float uTime;
            void main() {
              vUv = uv;
              vec3 p = position;
              p.z += sin(uv.y * 9.0 + uTime * 3.0) * 0.1 * (1.0 - uv.y) + (1.0 - uv.y) * (1.0 - uv.y) * 1.6;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }`,
          fragmentShader: `
            uniform float uTime;
            varying vec2 vUv;
            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
              vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
            }
            void main() {
              float x = vUv.x, y = vUv.y;
              float s1 = noise(vec2(x * 14.0, y * 3.0 + uTime * 2.6));
              float s2 = noise(vec2(x * 30.0 + 7.0, y * 6.0 + uTime * 4.1));
              float streak = s1 * 0.65 + s2 * 0.35;
              vec3 col = mix(vec3(0.35, 0.68, 0.9), vec3(0.95, 0.99, 1.0), smoothstep(0.45, 0.85, streak));
              float foam = smoothstep(0.2, 0.0, y) + smoothstep(0.92, 1.0, y) * 0.6;
              col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0));
              float edge = smoothstep(0.0, 0.16, x) * smoothstep(1.0, 0.84, x);
              gl_FragColor = vec4(col, clamp((0.62 + 0.38 * streak) * edge + foam * 0.3, 0.0, 0.95));
            }`
        });
        withFog(fallMat);
        const fall = new THREE.Mesh(new THREE.PlaneGeometry(4.6, W.lip, 6, 14), fallMat);
        fall.position.set(W.x + 0.2, Y0 + W.lip / 2, W.z);
        fall.rotation.y = Math.PI / 2;
        fall.renderOrder = 5;
        scene.add(fall);
        const pool = new THREE.Mesh(createBlobGeometry((a) => 1 + 0.12 * Math.sin(a * 3) + 0.05 * Math.sin(a * 7), 8, 48), createWaterMaterial({ shallow: 0x8fe6ee, deep: 0x1f6f8b, scale: 1.8 }));
        pool.scale.set(W.pool.r, 1, W.pool.r * 1.15);
        pool.position.set(W.pool.x, Y0 + 0.08, W.pool.z);
        pool.renderOrder = 3;
        scene.add(pool);
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2;
          if (Math.cos(a) < -0.7) continue; // lado da queda fica aberto
          const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + Math.random() * 0.6, 0), rockMat);
          rk.position.set(W.pool.x + Math.cos(a) * (W.pool.r + 0.4), Y0 + 0.2, W.pool.z + Math.sin(a) * (W.pool.r * 1.15 + 0.4));
          rk.scale.y = 0.6;
          bedroomWorld.add(rk);
        }
        obstacles.push({ x: W.x - 0.5, z: W.z, r: 2.4, h: W.lip, name: 'PAREDE DA CACHOEIRA', isStatic: true, level: 'floor' });

        // Lago do laço oeste (dentro das curvas), com juncos e vitórias-régias
        const pond = new THREE.Mesh(createBlobGeometry((a) => 1 + 0.1 * Math.sin(a * 3 + 1) + 0.05 * Math.sin(a * 5), 8, 48), createWaterMaterial({ scale: 1.6 }));
        pond.scale.set(POND.r, 1, POND.r);
        pond.position.set(POND.x, Y0 + 0.14, POND.z);
        pond.renderOrder = 3;
        scene.add(pond);
        const sand = new THREE.Mesh(createBlobGeometry((a) => 1.25 + 0.1 * Math.sin(a * 3 + 1), 3, 48), new THREE.MeshStandardMaterial({ color: 0xe8cf98, roughness: 0.95 }));
        sand.scale.set(POND.r, 1, POND.r);
        sand.position.set(POND.x, Y0 + 0.02, POND.z);
        bedroomWorld.add(sand);
        // (vitórias-régias agora são modelos da Kenney, ver placeNatureKenney)
        const reeds = [];
        for (let k = 0; k < 260; k++) {
          const a = Math.random() * Math.PI * 2, r = POND.r * (0.95 + Math.random() * 0.35);
          reeds.push({ x: POND.x + Math.cos(a) * r, y: Y0, z: POND.z + Math.sin(a) * r, h: 1.2 + Math.random() * 1.4 });
        }
        createGrassPatch(reeds);

        // Ponte alta de madeira (passagem de cima do cruzamento da ponte): tabuleiro, guarda-corpo e pilares
        const cB = RALLY_CROSSINGS[0];
        const deckMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.85, side: THREE.DoubleSide });
        const postMat = new THREE.MeshStandardMaterial({ color: 0x4a2e19, roughness: 0.85 });
        const n = Math.ceil(cB.Lh / RALLY_STEP);
        const dp = [], di = [];
        const lowerNear = (x, z) => rallySamples.some((s) => s.y < 0.3 && Math.abs(s.i - cB.under) < 40 && Math.hypot(s.x - x, s.z - z) < RALLY_SIDE + 1.6);
        let row = 0;
        for (let k = -n; k <= n; k++) {
          const s = rallySamples[(cB.over + k + RALLY_N) % RALLY_N];
          const nx = -s.tz, nz = s.tx, y = Y0 + 0.05 + s.y, L = RALLY_SIDE;
          dp.push(s.x - nx * L, y, s.z - nz * L, s.x - nx * L, y - 0.9, s.z - nz * L, s.x + nx * L, y - 0.9, s.z + nz * L, s.x + nx * L, y, s.z + nz * L);
          if (row > 0) {
            const a = (row - 1) * 4, b = row * 4;
            di.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2, a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
          }
          row++;
          if (s.y > 0.9 && k % 2 === 0) {
            [-1, 1].forEach((side) => {
              const px = s.x + nx * side * (L + 0.15), pz = s.z + nz * side * (L + 0.15);
              const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.3, 0.22), postMat);
              post.position.set(px, y + 0.65, pz);
              bedroomWorld.add(post);
              obstacles.push({ x: s.x + nx * side * (L + 0.7), z: s.z + nz * side * (L + 0.7), r: 0.7, y0: s.y - 0.4, h: s.y + 1.4, name: 'GUARDA-CORPO DA PONTE', isStatic: true, level: 'floor' });
            });
          }
          if (s.y > 2.2 && k % 6 === 0) {
            [-1, 1].forEach((side) => {
              const px = s.x + nx * side * (L - 0.7), pz = s.z + nz * side * (L - 0.7);
              if (lowerNear(px, pz)) return;
              const pil = new THREE.Mesh(new THREE.BoxGeometry(0.8, s.y - 0.9, 0.8), postMat);
              pil.position.set(px, Y0 + (s.y - 0.9) / 2, pz);
              pil.castShadow = true;
              bedroomWorld.add(pil);
              obstacles.push({ x: px, z: pz, r: 0.7, h: s.y - 0.9, name: 'PILAR DA PONTE', isStatic: true, level: 'floor' });
            });
          }
        }
        const deckGeo = new THREE.BufferGeometry();
        deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
        deckGeo.setIndex(di);
        deckGeo.computeVertexNormals();
        const deck = new THREE.Mesh(deckGeo, deckMat);
        deck.castShadow = true; deck.receiveShadow = true;
        bedroomWorld.add(deck);
        // Tábuas em relevo sobre o tabuleiro (instanciadas: 1 chamada de desenho)
        {
          const slatSamples = [];
          for (let k = -n; k <= n; k++) { const sm = rallySamples[(cB.over + k + RALLY_N) % RALLY_N]; if (sm.y > 0.35) slatSamples.push(sm); }
          const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(RALLY_W - 0.2, 0.14, RALLY_STEP * 0.78), new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.85 }), slatSamples.length);
          const d = new THREE.Object3D(), cc = new THREE.Color();
          slatSamples.forEach((sm, i) => {
            d.position.set(sm.x, Y0 + 0.12 + sm.y, sm.z);
            d.rotation.set(0, 0, 0);
            d.rotation.order = 'YXZ';
            d.rotation.y = Math.atan2(sm.tx, sm.tz);
            d.rotation.x = -Math.atan(sm.dy);
            d.updateMatrix();
            slats.setMatrixAt(i, d.matrix);
            slats.setColorAt(i, cc.setHex(i % 3 === 0 ? 0x8a5a2f : i % 3 === 1 ? 0xa0703f : 0x936338));
          });
          slats.receiveShadow = true;
          bedroomWorld.add(slats);
        }
        // Corrimão contínuo sobre os postes
        [-1, 1].forEach((side) => {
          const pts = [];
          for (let k = -n; k <= n; k++) {
            const s = rallySamples[(cB.over + k + RALLY_N) % RALLY_N];
            if (s.y <= 0.9) continue;
            pts.push(new THREE.Vector3(s.x - s.tz * side * (RALLY_SIDE + 0.15), Y0 + 0.05 + s.y + 1.25, s.z + s.tx * side * (RALLY_SIDE + 0.15)));
          }
          if (pts.length > 1) bedroomWorld.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.1, 6, false), postMat));
        });
      }
      const mistTex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const x = c.getContext('2d');
        const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
      })();
      rallyFx.puffTex = mistTex;
      for (let i = 0; i < 14; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
        scene.add(sp);
        rallyFx.mist.push({ sp, life: Math.random() * 2.5, max: 2.5, x: 0, y: 0, z: 0 });
      }
      // Poeira: nuvens de terra levantadas pelas rodas na pista
      for (let i = 0; i < 48; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, color: 0xc89268, transparent: true, opacity: 0, depthWrite: false }));
        sp.visible = false;
        scene.add(sp);
        rallyFx.dust.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1 });
      }

      // 3. Itens empurráveis na pista: barris, fardos de feno e caixotes de madeira
      // Junta as peças de um objeto numa malha só (cor por vértice): 1 chamada de desenho por item
      const pushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.15 });
      function mergeParts(parts) {
        const pos = [], nrm = [], col = [], idx = [];
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), cc = new THREE.Color(), one = new THREE.Vector3(1, 1, 1);
        parts.forEach((pt) => {
          const g2 = pt.geo.clone();
          eu.set(...(pt.rot || [0, 0, 0]));
          g2.applyMatrix4(m4.compose(new THREE.Vector3(...pt.pos), q.setFromEuler(eu), one));
          const base = pos.length / 3, n = g2.attributes.position.count;
          pos.push(...g2.attributes.position.array); nrm.push(...g2.attributes.normal.array);
          cc.setHex(pt.color).convertSRGBToLinear();
          for (let i = 0; i < n; i++) col.push(cc.r, cc.g, cc.b);
          if (g2.index) g2.index.array.forEach((v) => idx.push(v + base)); else for (let i = 0; i < n; i++) idx.push(base + i);
          g2.dispose();
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        return geo;
      }
      const BARREL_COLORS = [0xd62828, 0x2f55c8, 0xf4a300];
      const pushGeos = {
        barrel: BARREL_COLORS.map((c) => mergeParts([
          { geo: new THREE.CylinderGeometry(0.95, 0.95, 2.3, 16), color: c, pos: [0, 1.15, 0] },
          ...[0.35, 1.15, 1.95].map((yy) => ({ geo: new THREE.TorusGeometry(0.97, 0.06, 6, 20), color: 0x2b2e35, pos: [0, yy, 0], rot: [Math.PI / 2, 0, 0] }))
        ])),
        hay: [mergeParts([
          { geo: new THREE.BoxGeometry(2.6, 1.4, 1.5), color: 0xe0c060, pos: [0, 0.7, 0] },
          ...[-0.6, 0.6].map((xx) => ({ geo: new THREE.BoxGeometry(0.08, 1.44, 1.54), color: 0x8a5a2b, pos: [xx, 0.7, 0] }))
        ])],
        crate: [mergeParts([
          { geo: new THREE.BoxGeometry(1.8, 1.8, 1.8), color: 0xb07a45, pos: [0, 0.9, 0] },
          ...[[0, 0.9, 0.91, 1.8, 0.2, 0.04], [0, 0.9, -0.91, 1.8, 0.2, 0.04], [0.91, 0.9, 0, 0.04, 0.2, 1.8], [-0.91, 0.9, 0, 0.04, 0.2, 1.8]]
            .map(([px, py, pz, w, h, d]) => ({ geo: new THREE.BoxGeometry(w, h, d), color: 0x7a4b25, pos: [px, py, pz] }))
        ])]
      };
      function pushable(kind, x, z, rot) {
        const g = new THREE.Group();
        g.position.set(x, Y0, z);
        g.rotation.y = rot;
        const variants = pushGeos[kind];
        const mesh = new THREE.Mesh(variants[Math.floor(Math.random() * variants.length)], pushMat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        g.add(mesh);
        const obs = kind === 'barrel' ? { x, z, r: 1.0, h: 2.3, name: 'BARRIL' }
          : kind === 'hay' ? { x, z, r: 1.4, box: { hx: 1.3, hz: 0.75 }, h: 1.4, name: 'FARDO DE FENO' }
          : { x, z, r: 1.1, box: { hx: 0.9, hz: 0.9 }, h: 1.8, name: 'CAIXOTE DE MADEIRA' };
        bedroomWorld.add(g);
        const o = registerDynamicObstacle({ obs, group: g, mass: kind === 'barrel' ? 0.8 : kind === 'hay' ? 1.1 : 0.9, canTopple: true });
        if (kind === 'barrel') { o.friction = 0.95; o.restitution = 0.4; } // barril rola mais
        return o;
      }
      const kinds = ['barrel', 'hay', 'crate'];
      let placed = 0;
      for (let t = 0.03; t < 0.99 && placed < 22; t += 0.019) {
        const s = rallySampleAt(t);
        const lat = (Math.random() - 0.5) * (RALLY_W - 4);
        const x = s.x - s.tz * lat, z = s.z + s.tx * lat;
        if (rallyObstacleAt(x, z) || RALLY_TUNNELS.some((tn) => Math.abs(tn.t - t) < 0.03) || s.y > 0.1 || mountainH(x, z) > 0.2 ||
          RALLY_CROSSINGS.some((c) => Math.hypot(x - c.x, z - c.z) < 18)) continue;
        if (Math.random() < 0.55) {
          pushable(kinds[placed % 3], x, z, Math.random() * Math.PI);
          placed++;
          if (Math.random() < 0.4) { pushable(kinds[(placed + 1) % 3], x + s.tx * 2.4, z + s.tz * 2.4, Math.random() * Math.PI); placed++; }
        }
      }
    })();

    // Manchas de lama que ficam no chão (anel de 500: as mais antigas são reaproveitadas)
    const MUD_SPLATS = 500;
    // Respingo de lama: mancha principal irregular + gotículas em volta (recorte por alpha, sem polígono)
    const mudSplatTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#fff';
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * 18;
        x.beginPath(); x.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 14 + Math.random() * 16, 0, Math.PI * 2); x.fill();
      }
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, d = 34 + Math.random() * 26;
        x.beginPath(); x.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + Math.random() * 4.5, 0, Math.PI * 2); x.fill();
      }
      for (let i = 0; i < 6; i++) { // escorridos para fora
        const a = Math.random() * Math.PI * 2;
        x.lineWidth = 3 + Math.random() * 4; x.strokeStyle = '#fff'; x.lineCap = 'round';
        x.beginPath(); x.moveTo(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20); x.lineTo(64 + Math.cos(a) * (42 + Math.random() * 16), 64 + Math.sin(a) * (42 + Math.random() * 16)); x.stroke();
      }
      return new THREE.CanvasTexture(c);
    })();
    const mudSplatMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: mudSplatTex, alphaTest: 0.5, color: 0xffffff, roughness: 0.55, metalness: 0, envMapIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 }), MUD_SPLATS);
    mudSplatMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MUD_SPLATS * 3).fill(1), 3);
    mudSplatMesh.count = 0;
    mudSplatMesh.frustumCulled = false;
    mudSplatMesh.receiveShadow = true;
    scene.add(mudSplatMesh);
    let mudSplatNext = 0;
    const _splatObj = new THREE.Object3D(), _splatCol = new THREE.Color();
    const MUD_TONES = [0x3b2414, 0x4a2c18, 0x5a3a22, 0x2e1b0e, 0x6b4428];
    const MUD_FX = MUD_TONES.map((h) => new THREE.Color(h).convertSRGBToLinear().getHex()); // materiais básicos: cor já linear
    function addMudSplat(x, z, size) {
      const y = FLOOR_SURFACE_Y + 0.12 + Math.max(0, floorExtraHeight(x, z)) + rallyHeightAt(x, z);
      _splatObj.position.set(x, y, z);
      _splatObj.rotation.set(0, Math.random() * Math.PI, 0);
      const sc = size * (0.6 + Math.random() * 0.7);
      _splatObj.scale.set(sc * (0.8 + Math.random() * 0.5), 1, sc);
      _splatObj.updateMatrix();
      const i = mudSplatNext;
      mudSplatMesh.setMatrixAt(i, _splatObj.matrix);
      _splatCol.setHex(MUD_TONES[Math.floor(Math.random() * MUD_TONES.length)]).convertSRGBToLinear().multiplyScalar(0.8);
      mudSplatMesh.instanceColor.setXYZ(i, _splatCol.r, _splatCol.g, _splatCol.b);
      mudSplatNext = (mudSplatNext + 1) % MUD_SPLATS;
      mudSplatMesh.count = Math.max(mudSplatMesh.count, i + 1);
      mudSplatMesh.instanceMatrix.needsUpdate = true;
      mudSplatMesh.instanceColor.needsUpdate = true;
    }
    // Gotas de lama (instanciadas, arredondadas e esticadas pela velocidade); ao cair viram manchas no chão
    const MUD_DROPS = 280;
    const mudDropMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.24, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.05, envMapIntensity: 0.4 }), MUD_DROPS);
    mudDropMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MUD_DROPS * 3).fill(1), 3);
    mudDropMesh.frustumCulled = false;
    scene.add(mudDropMesh);
    const mudDrops = [];
    const _dropObj = new THREE.Object3D(), _dropUp = new THREE.Vector3(0, 1, 0), _dropVel = new THREE.Vector3();
    _dropObj.scale.setScalar(0); _dropObj.updateMatrix();
    for (let i = 0; i < MUD_DROPS; i++) { mudDrops.push({ i, life: 0 }); mudDropMesh.setMatrixAt(i, _dropObj.matrix); }
    let mudDropNext = 0;
    function spawnMudDrop(x, y, z, vx, vy, vz, size) {
      const d = mudDrops[mudDropNext];
      mudDropNext = (mudDropNext + 1) % MUD_DROPS;
      Object.assign(d, { x, y, z, vx, vy, vz, size, life: 1.8 });
      _splatCol.setHex(MUD_TONES[Math.floor(Math.random() * MUD_TONES.length)]).convertSRGBToLinear();
      mudDropMesh.instanceColor.setXYZ(d.i, _splatCol.r, _splatCol.g, _splatCol.b);
      mudDropMesh.instanceColor.needsUpdate = true;
    }
    function updateMudDrops(dt) {
      let dirty = false;
      for (let n = 0; n < MUD_DROPS; n++) {
        const d = mudDrops[n];
        if (d.life <= 0) continue;
        dirty = true;
        d.life -= dt;
        d.vy -= 22 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const g = FLOOR_SURFACE_Y + Math.max(0, floorExtraHeight(d.x, d.z)) + rallyHeightAt(d.x, d.z);
        if (d.y <= g + 0.05 || d.life <= 0) {
          if (d.y <= g + 0.05 && Math.random() < 0.6) addMudSplat(d.x, d.z, d.size * 1.3);
          d.life = 0;
          _dropObj.scale.setScalar(0);
          _dropObj.position.set(0, -999, 0);
        } else {
          _dropVel.set(d.vx, d.vy, d.vz);
          const sp = _dropVel.length();
          _dropObj.position.set(d.x, d.y, d.z);
          _dropObj.quaternion.setFromUnitVectors(_dropUp, _dropVel.multiplyScalar(1 / (sp || 1)));
          _dropObj.scale.set(d.size, d.size * (1 + Math.min(2.5, sp * 0.09)), d.size);
        }
        _dropObj.updateMatrix();
        mudDropMesh.setMatrixAt(d.i, _dropObj.matrix);
        _dropObj.quaternion.identity();
      }
      if (dirty) mudDropMesh.instanceMatrix.needsUpdate = true;
    }
    // Lama espirrada pelas rodas: jatos para os lados e para trás, névoa marrom e manchas no chão
    function sprayMud(x, z, angle, speed, power) {
      const fx = Math.sin(angle), fz = Math.cos(angle), rx = Math.cos(angle), rz = -Math.sin(angle);
      const sp = Math.abs(speed) * 60;
      const n = Math.round(4 + power * 7);
      for (let i = 0; i < n; i++) {
        const side = Math.random() > 0.5 ? 1 : -1;
        const wheelZ = Math.random() > 0.5 ? 1.3 : -1.3;
        const ox = x + rx * side * 1.3 + fx * wheelZ, oz = z + rz * side * 1.3 + fz * wheelZ;
        const lateral = (4 + Math.random() * 9) * power, back = sp * (0.15 + Math.random() * 0.35);
        spawnMudDrop(ox, FLOOR_SURFACE_Y + 0.5, oz,
          rx * side * lateral - fx * back + (Math.random() - 0.5) * 2, 4 + Math.random() * 7 * power, rz * side * lateral - fz * back + (Math.random() - 0.5) * 2,
          0.5 + Math.random() * 0.8 * power);
      }
      if (Math.random() < 0.6 * power) spawnDust(x - fx * 1.6, FLOOR_SURFACE_Y + 0.8, z - fz * 1.6, (Math.random() - 0.5) * 3 - fx * sp * 0.1, (Math.random() - 0.5) * 3 - fz * sp * 0.1, 1.3, 0x5a3a22);
    }
    // Rastro de pneu: marcas instanciadas (anel de 700) deixadas pelas rodas traseiras na terra e na lama
    const TRACK_MARKS = 700;
    const trackMarkTex = (() => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 64;
      const x = c.getContext('2d');
      x.fillStyle = 'rgba(255,255,255,0.0)'; x.fillRect(0, 0, 32, 64);
      x.fillStyle = '#fff';
      for (let y = 2; y < 64; y += 10) { x.fillRect(4, y, 10, 6); x.fillRect(18, y + 5, 10, 6); } // cravos do pneu
      return new THREE.CanvasTexture(c);
    })();
    const trackMarkMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.75, 1.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: trackMarkTex, color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }), TRACK_MARKS);
    trackMarkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TRACK_MARKS * 3).fill(1), 3);
    trackMarkMesh.count = 0;
    trackMarkMesh.frustumCulled = false;
    trackMarkMesh.renderOrder = 2;
    scene.add(trackMarkMesh);
    let trackMarkNext = 0, trackMarkDist = 0;
    const _tmObj = new THREE.Object3D(), _tmCol = new THREE.Color();
    function addTireTracks(x, groundY, z, angle, mud) {
      const fx = Math.sin(angle), fz = Math.cos(angle), rx = Math.cos(angle), rz = -Math.sin(angle);
      _tmCol.setHex(mud ? 0x2a170b : 0x7a4423);
      [-1.15, 1.15].forEach((side) => {
        const i = trackMarkNext;
        _tmObj.position.set(x - fx * 1.3 + rx * side, groundY, z - fz * 1.3 + rz * side);
        _tmObj.rotation.set(0, angle, 0);
        _tmObj.updateMatrix();
        trackMarkMesh.setMatrixAt(i, _tmObj.matrix);
        trackMarkMesh.instanceColor.setXYZ(i, _tmCol.r, _tmCol.g, _tmCol.b);
        trackMarkNext = (trackMarkNext + 1) % TRACK_MARKS;
        trackMarkMesh.count = Math.max(trackMarkMesh.count, i + 1);
      });
      trackMarkMesh.instanceMatrix.needsUpdate = true;
      trackMarkMesh.instanceColor.needsUpdate = true;
    }
    function spawnDust(x, y, z, vx, vz, size = 1, color = null) {
      const p = rallyFx.dust.find((d) => d.life <= 0);
      if (!p) return;
      p.life = p.max = 0.9 + Math.random() * 0.7;
      p.sp.position.set(x, y, z);
      p.vx = vx; p.vz = vz; p.vy = 0.8 + Math.random() * 0.8;
      p.s0 = size;
      if (color) p.sp.material.color.setHex(color); else p.sp.material.color.setHex(0xc89268);
      p.sp.visible = true;
    }
    function updateRallyFx(time, dt) {
      if (!IS_QUINTAL) return;
      rallyFx.dust.forEach((p) => {
        if (p.life <= 0) return;
        p.life -= dt;
        if (p.life <= 0) { p.sp.visible = false; return; }
        const k = 1 - p.life / p.max;
        p.sp.position.x += (p.vx + windState.x * windState.strength) * dt;
        p.sp.position.z += (p.vz + windState.z * windState.strength) * dt;
        p.sp.position.y += p.vy * dt;
        p.vx *= Math.exp(-2 * dt); p.vz *= Math.exp(-2 * dt);
        p.sp.scale.setScalar(p.s0 * (1.2 + k * 3.2));
        p.sp.material.opacity = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.45;
      });
      updateMudDrops(dt);
      // Rótulos dos obstáculos somem com a distância (antes ficavam sempre visíveis em todo o mundo)
      RALLY_OBSTACLES.forEach((o) => {
        if (!o.label) return;
        const d = Math.hypot(vehicle.position.x - o.cx, vehicle.position.z - o.cz);
        const a = 1 - THREE.MathUtils.smoothstep(d, 45, 75);
        o.label.visible = a > 0.02 && vehicle.position.y < -15;
        o.label.material.opacity = a;
      });
      const near = Math.hypot(vehicle.position.x - WATERFALL.x, vehicle.position.z - WATERFALL.z) < 160 && vehicle.position.y < -15;
      rallyFx.mist.forEach((m, i) => {
        m.sp.visible = near;
        if (!near) return;
        m.life -= dt;
        if (m.life <= 0) {
          m.max = m.life = 1.8 + Math.random() * 1.4;
          m.x = WATERFALL.x + 1.2 + Math.random() * 2; m.z = WATERFALL.z + (Math.random() - 0.5) * 4; m.y = FLOOR_SURFACE_Y + 0.6;
          if (Math.random() < 0.5) spawnFx(m.x, m.y, m.z, 1 + Math.random() * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3, 0xe8fbff, 0.8, 12, 0.4);
        }
        const k = 1 - m.life / m.max;
        m.x += dt * 1.4; m.y += dt * 1.6;
        m.sp.position.set(m.x, m.y, m.z);
        m.sp.scale.setScalar(2.5 + k * 6);
        m.sp.material.opacity = Math.sin(k * Math.PI) * 0.38;
      });
    }

    // Muito verde: árvores, arbustos, samambaias e gramados gerados fora do traçado, ilhas, riacho e penhasco
    const rallyTreeSpots = [];
    IS_QUINTAL && (function rallyGreenery() {
      const blocked = (x, z, pad) => {
        if (rallyNearest(x, z).dist < RALLY_SIDE + 3 + pad) return true;
        if (Math.hypot(x - 185, z - 64) < 15 + pad || Math.hypot(x - 152, z - 70) < 14 + pad || Math.hypot(x - 133, z - 47) < 14 + pad) return true; // ilhas (Baja, Fogueira, 86)
        if (Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z) < MOUNTAIN.r + pad) return true;   // montanha (decorada à parte)
        if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 3 + pad) return true;            // lago do miolo
        if (RALLY_CROSSINGS.some((c) => Math.hypot(x - c.x, z - c.z) < 14 + pad)) return true;
        return x < 130 || x > 326 || z < -68 || z > 90;
      };
      let trees = 0, tries = 0;
      while (trees < 34 && tries++ < 900) {
        const x = 130 + Math.random() * 196, z = -68 + Math.random() * 158;
        if (blocked(x, z, 2) || rallyTreeSpots.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 9)) continue;
        createTree(x, z, FLOOR_SURFACE_Y, 0.75 + Math.random() * 0.4, trees % 3);
        rallyTreeSpots.push([x, z]);
        scatterGrass(x, z, 4.5, 140);
        trees++;
      }
      let bushes = 0; tries = 0;
      while (bushes < 36 && tries++ < 900) {
        const x = 130 + Math.random() * 196, z = -68 + Math.random() * 158;
        if (blocked(x, z, 0)) continue;
        if (bushes % 2) createBush(x, z, FLOOR_SURFACE_Y, 0.55 + Math.random() * 0.4, bushes % 3);
        else createFern(x, z, FLOOR_SURFACE_Y, 0.8 + Math.random() * 0.5, 0);
        scatterGrass(x, z, 3.2, 90);
        bushes++;
      }
      // Faixas de grama acompanhando as bordas da pista
      const pts = [];
      for (let i = 0; i < RALLY_N; i += 1) {
        const s = rallySamples[i];
        for (let k = 0; k < 9; k++) {
          const side = Math.random() > 0.5 ? 1 : -1, lat = side * (RALLY_SIDE + 2 + Math.random() * 4.5);
          const x = s.x - s.tz * lat, z = s.z + s.tx * lat;
          if (rallyNearest(x, z).dist < RALLY_SIDE + 1.8) continue;
          pts.push({ x, y: FLOOR_SURFACE_Y, z, h: 0.45 + Math.random() * 0.9 });
        }
      }
      createGrassPatch(pts);
    })();

    // ============================================================================
    // MODELOS KENNEY (kenney.nl, CC0) — Racing Kit no rally: pórtico de largada, arquibancadas,
    // torres de banner, postes de luz, tendas de box, torre de cronometragem e outdoor.
    // Os GLBs da Kenney já vêm com cores de material: mantemos as cores e só ajustamos sombra/rugosidade.
    // ============================================================================
    const kenneyCache = new Map();
    function loadKenney(pack, name) {
      const key = pack + '/' + name;
      if (!kenneyCache.has(key)) {
        kenneyCache.set(key, new Promise((resolve, reject) => {
          const tryLoad = (attempt) => gltfLoader.load(`./models/kenney/${pack}/${name}.glb`, (g) => {
            g.scene.traverse((o) => {
              if (!o.isMesh) return;
              o.castShadow = true; o.receiveShadow = true;
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              mats.forEach((m) => { m.roughness = 0.8; m.metalness = 0; });
            });
            resolve(g.scene);
          }, undefined, (e) => (attempt < 2 ? setTimeout(() => tryLoad(attempt + 1), 400) : reject(e)));
          tryLoad(0);
        }));
      }
      return kenneyCache.get(key);
    }
    // GLBs de outras bibliotecas (Quaternius, KayKit, poly.pizza): carrega uma vez e reaproveita
    const glbCache = new Map();
    function loadGLB(url) {
      if (!glbCache.has(url)) {
        glbCache.set(url, new Promise((resolve, reject) => {
          const tryLoad = (attempt) => gltfLoader.load(url, (g) => {
            g.scene.traverse((o) => {
              if (!o.isMesh) return;
              o.castShadow = true; o.receiveShadow = true;
              (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.metalness = 0; m.roughness = Math.max(m.roughness, 0.7); });
            });
            resolve(g.scene);
          }, undefined, (e) => (attempt < 2 ? setTimeout(() => tryLoad(attempt + 1), 400) : reject(e)));
          tryLoad(0);
        }));
      }
      return glbCache.get(url);
    }
    // Embrulha o modelo num grupo com pivô na base/centro e escala para a medida pedida (height ou length)
    function fitToSize(obj, size) {
      const box = new THREE.Box3().setFromObject(obj), d = new THREE.Vector3(), c = new THREE.Vector3();
      box.getSize(d); box.getCenter(c);
      const s = size.height ? size.height / d.y : size.length / Math.max(d.x, d.z);
      obj.position.set(-c.x * s, -box.min.y * s, -c.z * s); obj.scale.multiplyScalar(s);
      const g = new THREE.Group(); g.add(obj);
      return g;
    }
    // Várias cópias de um GLB como InstancedMesh (uma chamada de desenho por malha). spots: [x, z, rotY, altura]
    function placeInstanced(url, spots, parent) {
      return loadGLB(url).then((proto) => {
        const unit = fitToSize(proto.clone(true), { height: 1 });
        unit.updateMatrixWorld(true);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        unit.traverse((o) => {
          if (!o.isMesh) return;
          const im = new THREE.InstancedMesh(o.geometry, o.material, spots.length);
          spots.forEach(([x, z, r, h], i) => {
            m4.compose(pos.set(x, FLOOR_SURFACE_Y, z), q.setFromAxisAngle(up, r), sc.setScalar(h)).multiply(o.matrixWorld);
            im.setMatrixAt(i, m4);
          });
          im.castShadow = true; im.receiveShadow = true;
          im.frustumCulled = false; // r128 testa só a esfera da malha original, não das instâncias
          (parent || scene).add(im);
        });
      }).catch((e) => console.warn('[glb]', url, e));
    }
    // Um GLB avulso no cenário, com medida em unidades do mundo (height ou length) e colisor opcional
    function placeGLB(url, opts) {
      if (opts.scene && opts.scene !== SCENE) return Promise.resolve(null); // o quarto também ocupa x > 118: o cenário vem explícito
      return loadGLB(url).then((proto) => {
        const m = fitToSize(proto.clone(true), opts.height ? { height: opts.height } : { length: opts.length });
        m.position.set(opts.x, opts.y !== undefined ? opts.y : FLOOR_SURFACE_Y, opts.z);
        m.rotation.set(opts.rotX || 0, opts.rotY || 0, 0);
        (opts.parent || scene).add(m);
        if (opts.collider) obstacles.push(Object.assign({ x: opts.x, z: opts.z, isStatic: true, level: 'floor', name: opts.name || 'OBJETO' }, opts.collider));
        if (opts.onLoad) opts.onLoad(m);
        return m;
      }).catch((e) => console.warn('[glb]', url, e));
    }
    function placeKenney(pack, name, opts) {
      if ((opts.x >= QUINTAL_MIN_X) !== IS_QUINTAL) return Promise.resolve(null);
      return loadKenney(pack, name).then((proto) => {
        const m = proto.clone(true);
        m.scale.setScalar(opts.scale || 10);
        m.position.set(opts.x, opts.y !== undefined ? opts.y : FLOOR_SURFACE_Y, opts.z);
        m.rotation.y = opts.rotY || 0;
        (opts.parent || bedroomWorld).add(m);
        if (opts.collider) obstacles.push(Object.assign({ x: opts.x, z: opts.z, isStatic: true, level: 'floor', name: opts.name || name.toUpperCase() }, opts.collider));
        if (opts.onLoad) opts.onLoad(m);
        return m;
      }).catch((e) => console.warn('[kenney]', name, e));
    }
    IS_QUINTAL && (function placeRallyKenney() {
      const K = 'racing-kit';
      const yawOf = (s) => Math.atan2(s.tx, s.tz);
      const at = (t, lat) => { const s = rallySampleAt(t); return { x: s.x - s.tz * lat, z: s.z + s.tx * lat, s }; };
      const clear = (x, z, pad) => rallyNearest(x, z).dist > RALLY_SIDE + pad && mountainH(x, z) < 0.1 &&
        Math.hypot(x - 185, z - 64) > 15 && Math.hypot(x - 152, z - 70) > 14 && Math.hypot(x - POND.x, z - POND.z) > POND.r + 3 &&
        x > 136 && x < 326 && z > -68 && z < 90;
      // 1. Pórtico de largada com luzes (no lugar das colunas azuis)
      {
        const s = rallySampleAt(0);
        placeKenney(K, 'overheadLights', { x: s.x, z: s.z, rotY: yawOf(s) + Math.PI / 2, scale: 11 });
        [-1, 1].forEach((side) => {
          const p = at(0.004, side * (RALLY_SIDE + 2.2));
          placeKenney(K, 'flagCheckers', { x: p.x, z: p.z, rotY: yawOf(p.s), scale: 7 });
        });
      }
      // 2. Arquibancadas cobertas olhando para a pista (lado com espaço livre)
      [0.035, 0.06, 0.62, 0.68].forEach((t, i) => {
        for (const side of [1, -1]) {
          const p = at(t, side * (RALLY_SIDE + 8));
          if (!clear(p.x, p.z, 6)) continue;
          const face = Math.atan2(p.s.x - p.x, p.s.z - p.z); // vira para a pista
          placeKenney(K, 'grandStandCovered', { x: p.x, z: p.z, rotY: face, scale: 9,
            collider: { r: 6.2, box: { hx: 4.5, hz: 4.5 }, boxRot: face, h: 10, name: 'ARQUIBANCADA' } });
          break;
        }
      });
      // 3. Torres de banner verde/vermelha nas retas
      [0.1, 0.2, 0.3, 0.46, 0.58, 0.76, 0.88, 0.97].forEach((t, i) => {
        const side = i % 2 ? 1 : -1;
        const p = at(t, side * (RALLY_SIDE + 3.5));
        if (!clear(p.x, p.z, 2.5)) return;
        placeKenney(K, i % 2 ? 'bannerTowerRed' : 'bannerTowerGreen', { x: p.x, z: p.z, rotY: yawOf(p.s), scale: 7,
          collider: { r: 1.6, h: 9, name: 'TORRE DE BANNER' } });
      });
      // 4. Postes de luz ao longo da pista (prontos para o modo noite)
      for (let t = 0.02; t < 1; t += 0.07) {
        const p = at(t, -(RALLY_SIDE + 4.5));
        if (!clear(p.x, p.z, 3.6)) continue;
        placeKenney(K, 'lightPostLarge', { x: p.x, z: p.z, rotY: yawOf(p.s) + Math.PI / 2, scale: 10,
          onLoad: (m) => {
            // A origem do modelo da Kenney não fica no pé do poste: acha o pé (vértices de baixo) e a luminária
            // (vértices de cima), encaixa o pé no ponto pedido e afasta o poste até a luminária ficar na beira da pista
            const lo = { x: 0, z: 0, n: 0 }, hi = { x: 0, z: 0, n: 0 }, v = new THREE.Vector3();
            const bb = new THREE.Box3().setFromObject(m), H = bb.max.y - bb.min.y;
            m.updateMatrixWorld(true);
            m.traverse((o) => {
              if (!o.isMesh) return;
              const pos = o.geometry.attributes.position;
              for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                if (v.y < bb.min.y + H * 0.15) { lo.x += v.x; lo.z += v.z; lo.n++; }
                else if (v.y > bb.max.y - H * 0.2) { hi.x += v.x; hi.z += v.z; hi.n++; }
              }
            });
            if (!lo.n || !hi.n) return;
            lo.x /= lo.n; lo.z /= lo.n; hi.x /= hi.n; hi.z /= hi.n;
            const nx = p.x - p.s.x, nz = p.z - p.s.z, nl = Math.hypot(nx, nz) || 1; // direção "para fora" da pista
            let bx = p.x, bz = p.z;
            const headDist = rallyNearest(bx + (hi.x - lo.x), bz + (hi.z - lo.z)).dist;
            if (headDist < RALLY_SIDE + 1) { const push = RALLY_SIDE + 1 - headDist; bx += (nx / nl) * push; bz += (nz / nl) * push; }
            m.position.x += bx - lo.x; m.position.z += bz - lo.z;
            obstacles.push({ x: bx, z: bz, r: 0.8, h: 8, isStatic: true, level: 'floor', name: 'POSTE DE LUZ' });
            const hx = bx + (hi.x - lo.x), hz = bz + (hi.z - lo.z);
            const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlowTexture, color: 0xffe2a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
            glow.position.set(hx, bb.max.y - 0.6, hz); glow.scale.setScalar(6);
            const pool = new THREE.Mesh(new THREE.CircleGeometry(7, 20), new THREE.MeshBasicMaterial({ map: softGlowTexture, color: 0xffe2a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
            pool.rotation.x = -Math.PI / 2; pool.position.set(hx, FLOOR_SURFACE_Y + 0.15, hz);
            bedroomWorld.add(glow, pool);
            nightGlows.push({ mat: glow.material, day: 0, night: 0.9 }, { mat: pool.material, day: 0, night: 0.35 });
          } });
      }
      // 5. Box (tendas) e torre de cronometragem ao lado da Ilha do Baja
      [[204, 72, 0.3, 'tent'], [212, 66, -0.2, 'tentClosed'], [206, 82, 0.5, 'tentClosed']].forEach(([x, z, r, n]) => {
        placeKenney(K, n, { x, z, rotY: r, scale: 8, collider: { r: 5, box: { hx: 4, hz: 4 }, boxRot: r, h: 6, name: 'TENDA DO BOX' } });
      });
      // Torre de cronometragem e outdoor na área do box, junto às tendas
      placeKenney(K, 'radarEquipment', { x: 196, z: 84, rotY: Math.PI, scale: 8, collider: { r: 3, h: 5, name: 'CRONOMETRAGEM' } });
      placeKenney(K, 'billboard', { x: 226, z: 82, rotY: Math.PI + 0.3, scale: 10, collider: { r: 2, h: 10, name: 'OUTDOOR' },
        onLoad: (m) => {
          // Troca a marca fictícia da Kenney por uma arte da equipe Piratas do Vale
          const c = document.createElement('canvas'); c.width = 512; c.height = 256;
          const x = c.getContext('2d');
          const gr = x.createLinearGradient(0, 0, 512, 256); gr.addColorStop(0, '#46123b'); gr.addColorStop(1, '#1d1721');
          x.fillStyle = gr; x.fillRect(0, 0, 512, 256);
          x.strokeStyle = '#ffceca'; x.lineWidth = 8; x.strokeRect(10, 10, 492, 236);
          x.fillStyle = '#e2b866'; x.textAlign = 'center'; x.font = 'bold 74px "Amatic SC", sans-serif';
          x.fillText('PIRATAS DO VALE', 256, 112);
          x.fillStyle = '#ffffff'; x.font = 'bold 40px Georgia, serif'; x.fillText('Baja SAE · Nº 13', 256, 176);
          x.fillStyle = '#ffceca'; x.font = '26px Nunito, sans-serif'; x.fillText('piratasdovalepcp.netlify.app', 256, 220);
          const tex = new THREE.CanvasTexture(c);
          tex.flipY = false; // texturas de GLB não são invertidas
          m.traverse((o) => { if (o.isMesh && o.material && o.material.map) { o.material = o.material.clone(); tex.wrapS = o.material.map.wrapS; tex.wrapT = o.material.map.wrapT; o.material.map = tex; o.material.needsUpdate = true; } });
        } });
    })();

    // ============================================================================
    // ILHA DA FOGUEIRA — fogo em shader, brasas, fumaça, brisa e muitas plantas/folhas soltas
    // (feita para avaliar a física do vento: folhas, gravetos, samambaias, arbustos e grama)
    // ============================================================================
    const CAMPFIRE = { x: 150, z: 72 };
    const campfireIsland = IS_QUINTAL && createIsland({
      id: 'campfire', name: 'Ilha da Fogueira', x: 152, z: 70, r: 11, point: [159, 62],
      text: 'Uma fogueira de acampamento com brisa suave. As chamas, as brasas e a fumaça seguem o vento; as folhas, gravetos, samambaias e a grama balançam e se espalham quando o carrinho passa. Bom lugar para ver a física da natureza!',
      actions: [
        { label: '🔥 Atiçar a fogueira', run: () => stokeCampfire() },
        { label: '🍃 Soprar uma rajada de vento', run: () => { windState.gustTimer = 5; showCarSpeech('Que ventania!', 2200); notify({ type: 'info', title: 'Rajada de vento', description: 'Veja as folhas, a grama, as plantas e as chamas seguindo o vento.', duration: 3500 }); } }
      ]
    });
    const flameMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: worldUniforms.uTime, uWind: worldUniforms.uWind, uPower: { value: 1 } },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uWind;
        uniform float uPower;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float hgt = uv.y;
          wp.xz += uWind.xy * uWind.z * hgt * hgt * 1.1;
          wp.x += sin(uTime * 7.0 + hgt * 5.0) * 0.14 * hgt;
          wp.y += hgt * (uPower - 1.0) * 1.6;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uPower;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
        void main() {
          float y = vUv.y;
          float n = fbm(vec2(vUv.x * 3.2, y * 2.6 - uTime * 2.8));
          float width = (1.0 - y) * 0.5 + 0.04;
          float x = abs(vUv.x - 0.5 + (n - 0.5) * 0.4 * y);
          float shape = smoothstep(width, width * 0.3, x) * smoothstep(1.0, 0.2 + n * 0.4, y) * smoothstep(0.0, 0.06, y);
          float core = smoothstep(width * 0.55, 0.0, x) * smoothstep(0.75, 0.0, y + (n - 0.5) * 0.3);
          vec3 col = mix(vec3(0.95, 0.18, 0.02), vec3(1.0, 0.62, 0.12), shape);
          col = mix(col, vec3(1.0, 0.95, 0.7), core);
          float a = clamp(shape * (0.75 + 0.25 * uPower), 0.0, 1.0);
          if (a < 0.01) discard;
          gl_FragColor = vec4(col * 1.15, a);
        }`
    });
    const campfire = !IS_QUINTAL ? null : (() => {
      const g = new THREE.Group();
      const Y = ISLAND_Y;
      g.position.set(CAMPFIRE.x, Y, CAMPFIRE.z);
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.9, flatShading: true });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55 + Math.random() * 0.15, 0), stoneMat);
        st.position.set(Math.cos(a) * 2.3, 0.3, Math.sin(a) * 2.3);
        st.scale.set(1.2, 0.8, 1);
        st.rotation.set(Math.random(), Math.random(), Math.random());
        st.castShadow = true;
        g.add(st);
      }
      const ash = new THREE.Mesh(new THREE.CircleGeometry(2.0, 24), new THREE.MeshStandardMaterial({ color: 0x2a2522, roughness: 1 }));
      ash.rotation.x = -Math.PI / 2; ash.position.y = 0.03;
      g.add(ash);
      const logMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.9 });
      const charMat = new THREE.MeshStandardMaterial({ color: 0x1d1512, emissive: 0xff4a10, emissiveIntensity: 0.35, roughness: 1 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 3.4, 7), i % 2 ? logMat : charMat);
        // Fogueira em pirâmide: cada lenha inclina o topo para o centro
        log.quaternion.setFromAxisAngle(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), 0.45);
        log.position.set(Math.cos(a) * 0.75, 1.5, Math.sin(a) * 0.75);
        log.castShadow = true;
        g.add(log);
      }
      const emberBed = new THREE.Mesh(new THREE.CircleGeometry(1.4, 20), new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      emberBed.rotation.x = -Math.PI / 2; emberBed.position.y = 0.08;
      g.add(emberBed);
      const flames = [];
      [[3.0, 4.6, 0], [3.0, 4.6, Math.PI / 3], [3.0, 4.6, 2 * Math.PI / 3], [1.8, 3.0, Math.PI / 6], [1.8, 3.0, Math.PI / 2 + 0.3]].forEach(([w, h, r]) => {
        const geo = new THREE.PlaneGeometry(w, h);
        geo.translate(0, h / 2, 0);
        const f = new THREE.Mesh(geo, flameMaterial);
        f.position.y = 0.2;
        f.rotation.y = r;
        f.renderOrder = 6;
        g.add(f);
        flames.push(f);
      });
      // Brilho aquecido no chão em volta (halo aditivo)
      const glowTex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const x = c.getContext('2d');
        const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
      })();
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff7a2a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = 0.06;
      g.add(halo);
      const light = new THREE.PointLight(0xff8a3a, 1.5, 44, 2);
      light.position.set(0, 2.6, 0);
      g.add(light);
      scene.add(g);
      obstacles.push({ x: CAMPFIRE.x, z: CAMPFIRE.z, r: 2.9, h: 3, name: 'FOGUEIRA', isStatic: true, level: 'floor' });
      // Brasas (instanciadas) e fumaça (sprites)
      const EMBERS = 40;
      const embers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0xffa040 }), EMBERS);
      embers.frustumCulled = false;
      scene.add(embers);
      const emberState = [];
      for (let i = 0; i < EMBERS; i++) emberState.push({ life: Math.random() * 2, max: 2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ph: Math.random() * 10 });
      const smokeMat = new THREE.SpriteMaterial({ map: glowTex, color: 0x9a948c, transparent: true, opacity: 0, depthWrite: false });
      const smoke = [];
      for (let i = 0; i < 12; i++) {
        const sp = new THREE.Sprite(smokeMat.clone());
        scene.add(sp);
        smoke.push({ sp, life: Math.random() * 4, max: 4, x: 0, y: 0, z: 0 });
      }
      return { group: g, flames, light, emberBed, halo, embers, emberState, smoke, power: 1, powerTimer: 0, nextCrackle: 0 };
    })();
    function stokeCampfire() {
      campfire.powerTimer = 5;
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
        spawnFx(CAMPFIRE.x, ISLAND_Y + 1.5, CAMPFIRE.z, Math.cos(a) * s, 6 + Math.random() * 8, Math.sin(a) * s, Math.random() > 0.4 ? 0xffa040 : 0xffe27a, 1.4, 6, 0.4);
      }
      playTone(90, 0, 0.3, 'sawtooth', 0.05);
      showCarSpeech('Fogo bonito! 🔥', 2200);
    }
    const _emberObj = new THREE.Object3D();
    function updateCampfire(time, dt) {
      if (!campfire) return;
      const cf = campfire;
      const dx = vehicle.position.x - CAMPFIRE.x, dz = vehicle.position.z - CAMPFIRE.z;
      const dist = Math.hypot(dx, dz);
      const visible = dist < 170 && vehicle.position.y < -15;
      cf.group.visible = visible; cf.embers.visible = visible;
      if (!visible) { cf.smoke.forEach(s => { s.sp.visible = false; }); return; }
      if (cf.powerTimer > 0) cf.powerTimer -= dt;
      cf.power += ((cf.powerTimer > 0 ? 1.8 : 1) - cf.power) * Math.min(1, dt * 2.5);
      flameMaterial.uniforms.uPower.value = cf.power;
      const flick = 0.85 + Math.sin(time * 13) * 0.08 + Math.sin(time * 23 + 1) * 0.06 + Math.random() * 0.06;
      cf.light.intensity = 1.5 * flick * cf.power;
      cf.halo.material.opacity = 0.26 * flick * cf.power;
      cf.emberBed.material.opacity = 0.6 + Math.sin(time * 3) * 0.2;
      cf.flames.forEach((f, i) => { f.scale.set(1, (0.92 + Math.sin(time * (5 + i) + i) * 0.08) * (0.8 + cf.power * 0.2), 1); });
      const wx = windState.x * windState.strength, wz = windState.z * windState.strength;
      cf.emberState.forEach((e, i) => {
        e.life -= dt;
        if (e.life <= 0) {
          e.max = e.life = 1.2 + Math.random() * 1.8;
          e.x = CAMPFIRE.x + (Math.random() - 0.5) * 1.4; e.z = CAMPFIRE.z + (Math.random() - 0.5) * 1.4; e.y = ISLAND_Y + 0.8 + Math.random();
          e.vx = (Math.random() - 0.5) * 0.8; e.vz = (Math.random() - 0.5) * 0.8; e.vy = 2.2 + Math.random() * 2.2 * cf.power;
        }
        e.vx += (wx * 2.2 + Math.sin(time * 3 + e.ph) * 1.2) * dt;
        e.vz += (wz * 2.2 + Math.cos(time * 2.6 + e.ph) * 1.2) * dt;
        e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
        _emberObj.position.set(e.x, e.y, e.z);
        _emberObj.rotation.set(time * 3 + e.ph, time * 2, 0);
        _emberObj.scale.setScalar(Math.max(0.001, e.life / e.max) * (0.7 + 0.6 * Math.sin(time * 20 + e.ph) ** 2));
        _emberObj.updateMatrix();
        cf.embers.setMatrixAt(i, _emberObj.matrix);
      });
      cf.embers.instanceMatrix.needsUpdate = true;
      cf.smoke.forEach((s, i) => {
        s.life -= dt;
        if (s.life <= 0) {
          s.max = s.life = 3.5 + Math.random() * 1.5;
          s.x = CAMPFIRE.x + (Math.random() - 0.5); s.z = CAMPFIRE.z + (Math.random() - 0.5); s.y = ISLAND_Y + 3.5;
        }
        const k = 1 - s.life / s.max;
        s.x += wx * 2.4 * dt; s.z += wz * 2.4 * dt; s.y += (1.6 + k) * dt;
        s.sp.visible = true;
        s.sp.position.set(s.x + Math.sin(time + i) * 0.4 * k, s.y, s.z);
        s.sp.scale.setScalar(1.6 + k * 6);
        s.sp.material.opacity = Math.sin(Math.min(1, k * 1.2) * Math.PI) * 0.32;
      });
      // Estalos da lenha quando o carrinho está por perto
      if (dist < 30 && time > cf.nextCrackle) {
        cf.nextCrackle = time + 0.15 + Math.random() * 0.6;
        playTone(180 + Math.random() * 600, 0, 0.025, 'square', 0.012 * (1 - dist / 30));
      }
    }

    // Samambaias: folíolos ao longo de frondes curvas, com o mesmo shader de vento das copas
    function createFern(x, z, y, scale = 1, variant = 0) {
      if ((x >= QUINTAL_MIN_X) !== IS_QUINTAL) return;
      const pos = [], uv = [], centers = [], shade = [], heights = [], idx = [];
      const fronds = 7 + Math.floor(Math.random() * 3);
      for (let f = 0; f < fronds; f++) {
        const a = (f / fronds) * Math.PI * 2 + Math.random() * 0.4;
        const len = (2.4 + Math.random() * 1.2) * scale;
        const ca = Math.cos(a), sa = Math.sin(a);
        const leaflets = 9;
        for (let l = 1; l <= leaflets; l++) {
          const u = l / leaflets;
          const r = u * len;
          const hgt = Math.sin(u * Math.PI * 0.75) * len * 0.75;
          const cx = x + ca * r, cz = z + sa * r, cy = y + 0.2 + hgt;
          const s = (0.5 - u * 0.28) * scale;
          [-1, 1].forEach((side) => {
            const px = cx - sa * side * s * 0.9, pz = cz + ca * side * s * 0.9;
            const base = pos.length / 3;
            // folíolo como cartão inclinado apontando para fora da fronde
            const rx = ca * s, rz = sa * s, ux = -sa * side * s, uz = ca * side * s;
            [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([p, q, uu, vv]) => {
              pos.push(px + rx * p + ux * q, cy + q * s * 0.25, pz + rz * p + uz * q);
              uv.push(uu, vv);
              centers.push(px, cy, pz);
              shade.push(0.25 + u * 0.7);
              heights.push(0.35 + u * 0.75);
            });
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          });
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
      g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
      g.setAttribute('aHeight', new THREE.Float32BufferAttribute(heights, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      g.boundingSphere.radius += 2;
      scene.add(new THREE.Mesh(g, foliageMaterials[variant % foliageMaterials.length]));
    }
    IS_QUINTAL && (function decorateCampfireIsland() {
      const X = 152, Z = 70, Y = ISLAND_Y;
      // Troncos-banco em volta da fogueira
      const benchMat = new THREE.MeshStandardMaterial({ color: 0x7a4b2a, roughness: 0.9 });
      [[-0.9, 4.6], [1.2, 4.8], [2.9, 4.4]].forEach(([a, r]) => {
        const bx = CAMPFIRE.x + Math.cos(a) * r, bz = CAMPFIRE.z + Math.sin(a) * r;
        const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 4.2, 10), benchMat);
        bench.rotation.z = Math.PI / 2; bench.rotation.y = -a;
        bench.position.set(bx, Y + 0.55, bz);
        bench.castShadow = true;
        scene.add(bench);
        obstacles.push({ x: bx, z: bz, r: 1.2, box: { hx: 2.1, hz: 0.6 }, boxRot: -a, h: 1.1, name: 'TRONCO-BANCO', isStatic: true, level: 'floor' });
      });
      // Samambaias, arbustos floridos e uma arvorezinha na borda da ilha
      [[0.3, 8.2, 1.0, 0], [1.4, 8.6, 0.85, 0], [2.4, 8.0, 1.1, 0], [3.4, 8.4, 0.9, 0], [4.4, 8.5, 1.0, 0], [5.3, 8.0, 0.9, 0]].forEach(([a, r, s, v]) => {
        createFern(X + Math.cos(a) * r, Z + Math.sin(a) * r, Y, s, v);
      });
      [[0.9, 9.2, 0.6, 1], [3.0, 9.0, 0.65, 2], [4.9, 9.4, 0.55, 1]].forEach(([a, r, s, v]) => createBush(X + Math.cos(a) * r, Z + Math.sin(a) * r, Y, s, v));
      createTree(X - 7.5, Z + 5.5, Y, 0.7, 2);
      // Capim alto em anel (fica entre a fogueira e as samambaias)
      const pts = [];
      for (let i = 0; i < 900; i++) {
        const a = Math.random() * Math.PI * 2, r = 6.8 + Math.random() * 3.6;
        pts.push({ x: X + Math.cos(a) * r, y: Y, z: Z + Math.sin(a) * r, h: 0.9 + Math.random() * 1.0 });
      }
      createGrassPatch(pts);
    })();

    // Kenney Nature Kit (CC0): pinheiros/rochas/troncos na montanha, acampamento na Ilha da Fogueira,
    // vitórias-régias no lago do miolo, canoa no lago do quarto e detalhes na floresta do rally
    (function placeNatureKenney() {
      const NK = 'nature-kit', Y0 = FLOOR_SURFACE_Y;
      if (IS_QUARTO) {
        // Canoa com remo na margem do lago do quarto
        placeKenney(NK, 'canoe', { x: LAKE.x - LAKE.rx - 2.5, z: LAKE.z + 2, y: Y0 + 0.05, rotY: Math.PI / 2 + 0.3, scale: 7,
          collider: { r: 1.6, box: { hx: 1.1, hz: 4 }, boxRot: Math.PI / 2 + 0.3, h: 1.3, name: 'CANOA' } });
        placeKenney(NK, 'canoe_paddle', { x: LAKE.x - LAKE.rx - 1, z: LAKE.z - 3, y: Y0 + 0.1, rotY: 0.9, scale: 7 });
        return;
      }
      const rnd = (a, b) => a + Math.random() * (b - a);
      // 1. Montanha da cachoeira
      const mountainSpots = [];
      for (let n = 0; n < 900 && mountainSpots.length < 34; n++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (MOUNTAIN.r - 2);
        const x = MOUNTAIN.x + Math.cos(a) * r, z = MOUNTAIN.z + Math.sin(a) * r;
        const h = mountainH(x, z);
        if (h < 2.5 || rallyNearest(x, z).dist < RALLY_SIDE + 4.5) continue;
        if (Math.abs(z - WATERFALL.z) < 6 && x > WATERFALL.x - 14) continue;
        if (mountainSpots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 5)) continue;
        mountainSpots.push([x, z, h]);
      }
      const mountainItems = [
        ['tree_pineTallA_detailed', 8, 1.2, 12], ['tree_pineRoundC', 8, 1.4, 10], ['tree_pineSmallB', 7, 1.0, 7],
        ['rock_tallB', 5, 2.2, 4.4], ['rock_largeC', 5, 2.6, 1.6], ['stump_old', 5, 0.9, 1.4],
        ['mushroom_redGroup', 5, 0, 0], ['flower_yellowB', 5, 0, 0], ['flower_purpleC', 5, 0, 0], ['log_large', 5, 2.2, 2.1]
      ];
      mountainSpots.forEach(([x, z, h], i) => {
        const [name, scale, r, ih] = mountainItems[i % mountainItems.length];
        const s = scale * rnd(0.85, 1.2);
        placeKenney(NK, name, { x, z, y: Y0 + h - 0.15, rotY: Math.random() * Math.PI * 2, scale: s,
          collider: r ? { r: r * s / scale, y0: h - 0.6, h: h + ih * s / scale, name: name.startsWith('tree') ? 'PINHEIRO' : 'ROCHA' } : null });
      });
      // 2. Ilha da Fogueira: barraca, lenha, tocos, placa e canteiros de flores
      const faceFire = (x, z) => Math.atan2(CAMPFIRE.x - x, CAMPFIRE.z - z);
      placeKenney(NK, 'tent_detailedOpen', { x: 144.5, z: 65.5, y: ISLAND_Y, rotY: faceFire(144.5, 65.5) + Math.PI, scale: 9,
        collider: { r: 4.2, box: { hx: 3.9, hz: 3.0 }, boxRot: faceFire(144.5, 65.5) + Math.PI, h: 5, name: 'BARRACA' } });
      placeKenney(NK, 'log_stack', { x: 157.5, z: 76.5, y: ISLAND_Y, rotY: 0.6, scale: 6, collider: { r: 2.2, h: 2.2, name: 'LENHA' } });
      placeKenney(NK, 'sign', { x: 162, z: 67.5, y: ISLAND_Y, rotY: -2.2, scale: 6, collider: { r: 0.6, h: 2.5, name: 'PLACA' } });
      [[146.5, 70], [154, 75.5]].forEach(([x, z]) => placeKenney(NK, 'stump_round', { x, z, y: ISLAND_Y, rotY: Math.random() * 6, scale: 5, collider: { r: 1, h: 1.1, name: 'TOCO' } }));
      ['flower_redA', 'flower_yellowB', 'flower_purpleC', 'mushroom_redGroup', 'mushroom_tanGroup'].forEach((name, k) => {
        for (let n = 0; n < 4; n++) {
          const a = (k * 4 + n) / 20 * Math.PI * 2 + rnd(-0.1, 0.1), r = rnd(6.2, 9.4);
          placeKenney(NK, name, { x: 152 + Math.cos(a) * r, z: 70 + Math.sin(a) * r, y: ISLAND_Y, rotY: Math.random() * 6, scale: rnd(4, 5.5) });
        }
      });
      // 3. Vitórias-régias de verdade no lago do miolo
      for (let n = 0; n < 7; n++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * (POND.r - 1.4);
        placeKenney(NK, n % 3 ? 'lily_small' : 'lily_large', { x: POND.x + Math.cos(a) * r, z: POND.z + Math.sin(a) * r, y: Y0 + 0.1, rotY: Math.random() * 6, scale: 5 });
      }
      // 5. Floresta do rally: tocos, cogumelos e flores junto às árvores
      const forestBits = ['stump_old', 'mushroom_redGroup', 'flower_yellowB', 'mushroom_tanGroup', 'plant_bushSmall', 'flower_redA', 'mushroom_redTall'];
      rallyTreeSpots.slice(0, 22).forEach(([x, z], i) => {
        const a = Math.random() * Math.PI * 2;
        const px = x + Math.cos(a) * 3.2, pz = z + Math.sin(a) * 3.2;
        if (rallyNearest(px, pz).dist < RALLY_SIDE + 2) return;
        const name = forestBits[i % forestBits.length];
        placeKenney(NK, name, { x: px, z: pz, rotY: Math.random() * 6, scale: name === 'plant_bushSmall' ? 6 : 5,
          collider: name === 'stump_old' ? { r: 1.1, h: 1.4, name: 'TOCO' } : null });
      });
    })();

    // ============================================================================
    // MOEDAS COLECIONÁVEIS (Kenney Toy Car Kit) — 40 moedas fixas pela mesa, quarto e rally
    // bronze = 1, prata = 2, ouro = 5. Ficam salvas no aparelho; conquista "Cofrinho do Ravi".
    // ============================================================================
    const COIN_COUNT = 40;
    const COIN_KEY = 'coinsCollected_v1';
    const coins = [];
    let coinMeshes = null;
    const coinCollected = (() => { try { return new Set(JSON.parse(localStorage.getItem(COIN_KEY) || '[]')); } catch (e) { return new Set(); } })();
    (function placeCoins() {
      // Gerador pseudoaleatório com semente: as moedas ficam sempre nos mesmos lugares
      let seed = 1307;
      const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const farFromStatic = (x, z, level, pad) => !obstacles.some((o) => (o.level || 'desk') === level && !o._dyn && Math.hypot(o.x - x, o.z - z) < (o.box ? Math.hypot(o.box.hx, o.box.hz) : o.r) + pad);
      const add = (x, y, z, level) => coins.push({ id: coins.length, x, y, z, level, type: coins.length % 8 === 0 ? 'gold' : coins.length % 8 < 4 ? 'silver' : 'bronze' });
      // Mesa: 10
      for (let n = 0; n < 400 && coins.length < 10; n++) {
        const x = (rand() * 2 - 1) * (DESK_HALF_W - 6), z = (rand() * 2 - 1) * (DESK_HALF_D - 6);
        if (!farFromStatic(x, z, 'desk', 3) || coins.some((c) => Math.hypot(c.x - x, c.z - z) < 12)) continue;
        add(x, deskY(x, z) + 1.3, z, 'desk');
      }
      // Quarto: 12
      for (let n = 0; n < 600 && coins.length < 22; n++) {
        const x = -160 + rand() * 280, z = -66 + rand() * 150;
        if (isInLake(x, z, -0.1) || !farFromStatic(x, z, 'floor', 3) || coins.some((c) => Math.hypot(c.x - x, c.z - z) < 18)) continue;
        if (Math.abs(x) < DESK_HALF_W + 2 && Math.abs(z) < DESK_HALF_D + 2 && rand() < 0.5) continue; // nem todas embaixo da mesa
        add(x, FLOOR_SURFACE_Y + Math.max(0, floorExtraHeight(x, z)) + 1.3, z, 'floor');
      }
      // Rally: o resto, em cima da pista (inclusive na ponte e no cume da montanha)
      const left = COIN_COUNT - coins.length;
      for (let k = 0; k < left; k++) {
        const s = rallySamples[Math.floor(((k + 0.5) / left) * RALLY_N) % RALLY_N];
        const lat = (rand() * 2 - 1) * 3;
        const x = s.x - s.tz * lat, z = s.z + s.tx * lat;
        const h = s.y > 0.05 ? s.y : rallyHeightAt(x, z);
        add(x, FLOOR_SURFACE_Y + 1.3 + h, z, 'floor');
      }
      // Visual: 1 InstancedMesh por tipo (pegamos geometria e material do GLB da Kenney)
      Promise.all(['gold', 'silver', 'bronze'].map((t) => loadKenney('toy-car-kit', 'item-coin-' + t))).then((protos) => {
        coinMeshes = {};
        ['gold', 'silver', 'bronze'].forEach((t, i) => {
          protos[i].updateMatrixWorld(true);
          let src = null;
          protos[i].traverse((o) => { if (o.isMesh && !src) src = o; });
          if (!src) return;
          const mat = src.material.clone();
          mat.metalness = 0.55; mat.roughness = 0.3;
          if (mat.emissive) { mat.emissive.setHex(t === 'gold' ? 0x553300 : t === 'silver' ? 0x222833 : 0x331a0a); }
          const geo = src.geometry.clone();
          geo.applyMatrix4(src.matrixWorld);
          geo.center();
          const list = coins.filter((c) => c.type === t);
          const im = new THREE.InstancedMesh(geo, mat, list.length);
          im.castShadow = true;
          im.frustumCulled = false;
          list.forEach((c, j) => { c.mesh = im; c.slot = j; });
          scene.add(im);
          coinMeshes[t] = im;
        });
      }).catch((e) => console.warn('[moedas]', e));
    })();
    const _coinObj = new THREE.Object3D();
    function coinValue(c) { return c.type === 'gold' ? 5 : c.type === 'silver' ? 2 : 1; }
    function coinScore() { let v = 0; coins.forEach((c) => { if (coinCollected.has(c.id)) v += coinValue(c); }); return v; }
    function updateCoins(time) {
      if (!coinMeshes) return;
      const cp = vehicle.position;
      let dirty = false;
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        if (!c.mesh) continue;
        const got = coinCollected.has(c.id) || (c.x >= QUINTAL_MIN_X) !== IS_QUINTAL; // moeda de outro cenário: escondida
        if (!got && Math.abs(cp.x - c.x) < 2.8 && Math.abs(cp.z - c.z) < 2.8 && Math.abs(cp.y + 1 - c.y) < 2.6 && Math.hypot(cp.x - c.x, cp.z - c.z) < 2.6) {
          coinCollected.add(c.id);
          try { localStorage.setItem(COIN_KEY, JSON.stringify([...coinCollected])); } catch (e) { /* sem storage */ }
          if (!sfx('powerUp', { vol: 0.5, rate: c.type === 'gold' ? 1.3 : c.type === 'silver' ? 1.15 : 1 })) playTone(988, 0, 0.08, 'triangle', 0.05);
          for (let k = 0; k < 10; k++) { const a = Math.random() * Math.PI * 2; spawnFx(c.x, c.y, c.z, Math.cos(a) * 3, 4 + Math.random() * 3, Math.sin(a) * 3, c.type === 'gold' ? 0xffd166 : c.type === 'silver' ? 0xe6edf5 : 0xd08a55, 0.6, 14, 0.5); }
          setStatusBanner(`🪙 Moedas: ${coinCollected.size}/${COIN_COUNT} · ${coinScore()} pontos`, '#ffd166');
          progressAchievement('coins', coinCollected.size, true);
          if (coinCollected.size === COIN_COUNT) { confettiBurst(cp.x, cp.y + 3, cp.z, 90); showCarSpeech('Cofrinho cheio! 🪙', 2600); }
        }
        _coinObj.position.set(c.x, c.y + Math.sin(time * 2.2 + i) * 0.25, c.z);
        _coinObj.rotation.set(0, time * 2.4 + i, 0);
        _coinObj.scale.setScalar(got ? 0 : (c.level === 'desk' ? 6 : 9));
        _coinObj.updateMatrix();
        c.mesh.setMatrixAt(c.slot, _coinObj.matrix);
        dirty = true;
      }
      if (dirty) Object.values(coinMeshes).forEach((m) => { m.instanceMatrix.needsUpdate = true; });
    }
    function resetCoins() {
      coinCollected.clear();
      try { localStorage.removeItem(COIN_KEY); } catch (e) { /* sem storage */ }
    }

    // ============================================================================
    // LANCHES DA MESA (Kenney Food Kit): empurráveis, dá para pegar, e quebram com batidas
    // ============================================================================
    const KENNEY_FOOD = [['donut-sprinkles', 12, 'Donut'], ['cupcake', 8, 'Cupcake'], ['cookie-chocolate', 20, 'Cookie'], ['popsicle', 8, 'Picolé'], ['soda-can', 9, 'Refrigerante'], ['fries', 8, 'Batata frita']];
    IS_QUARTO && setTimeout(() => {
      let seed = 4242;
      const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const placed = [];
      KENNEY_FOOD.forEach(([name, scale, label]) => {
        for (let n = 0; n < 300; n++) {
          const x = (rand() * 2 - 1) * (DESK_HALF_W - 8), z = (rand() * 2 - 1) * (DESK_HALF_D - 8);
          const clear = !obstacles.some((o) => (o.level || 'desk') === 'desk' && Math.hypot(o.x - x, o.z - z) < (o.box ? Math.hypot(o.box.hx, o.box.hz) : o.r) + 3.5) &&
            !placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 10) && !trackSamples.some((s) => s.y > -15 && Math.hypot(s.x - x, s.z - z) < TRACK_WIDTH / 2 + 2);
          if (!clear) continue;
          placed.push([x, z]);
          loadKenney('food-kit', name).then((proto) => {
            const g = new THREE.Group();
            const m = proto.clone(true);
            m.scale.setScalar(scale);
            g.add(m);
            const y = deskY(x, z);
            g.position.set(x, y, z);
            g.rotation.y = rand() * Math.PI * 2;
            deskWorld.add(g);
            const box = new THREE.Box3().setFromObject(m), size = box.getSize(new THREE.Vector3());
            const obs = registerDynamicObstacle({ obs: { x, z, r: Math.max(size.x, size.z) * 0.5 + 0.2, h: size.y, name: label.toUpperCase() }, group: g, mass: 0.4, canTopple: true });
            registerGrabbable({ id: 'kfood_' + name, name: label, group: g, obs, initX: x, initY: y, initZ: z, initRotY: g.rotation.y, grabRadius: 4.5 });
            setupBreakable(obs, g, 'food', m);
          });
          break;
        }
      });
    }, 1800);

    // ============================================================================
    // ILHA DOS BRINQUEDOS + QUARTO (Kenney Minigolf / Furniture): moinho girando, castelo, bandeira, ursinho
    // ============================================================================
    let windmillBlades = null;
    placeKenney('minigolf-kit', 'structure-windmill', { x: -68, z: 79, y: FLOOR_SURFACE_Y, rotY: 1.2, scale: 8, collider: { r: 3.4, h: 10, name: 'MOINHO DE VENTO' },
      onLoad: (m) => { m.traverse((o) => { if (o.name === 'blades') windmillBlades = o; }); } });
    placeKenney('minigolf-kit', 'castle', { x: -42.5, z: 86.5, y: ISLAND_Y, rotY: -0.5, scale: 6, collider: { r: 3.6, box: { hx: 3, hz: 3 }, boxRot: -0.5, h: 4, name: 'CASTELINHO' } });
    placeKenney('minigolf-kit', 'flag-large-red', { x: -63, z: 74, y: ISLAND_Y, rotY: 0.3, scale: 6 });
    // Cantinho gamer e tralhas do KayKit (Kay Lousberg, CC0) na parte leste do quarto
    {
      const KK = (n) => './models/kaykit/' + n + '.glb', Q = 'quarto';
      placeGLB(KK('gamer_chair_A'), { scene: Q, x: 180, z: -58, rotY: 0, height: 15, collider: { r: 5, h: 15 }, name: 'CADEIRA GAMER' });
      placeGLB(KK('handheld_console'), { scene: Q, x: 192, z: -48, rotY: -0.6, length: 4.5 });
      // Desenhos "de criança" no lugar da imagem de exemplo dos quadros
      const drawing = (w, h, paint) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = '#fffaf0'; x.fillRect(0, 0, w, h);
        x.lineWidth = 6; x.lineCap = x.lineJoin = 'round';
        paint(x, w, h);
        const t = new THREE.CanvasTexture(c); t.flipY = false; t.encoding = THREE.sRGBEncoding;
        return t;
      };
      const setPicture = (tex) => (m) => m.traverse((o) => {
        if (o.isMesh && o.material && o.material.name === 'placeholder') o.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
      });
      const truckArt = drawing(512, 340, (x, w, h) => {
        x.fillStyle = '#7ec8ff'; x.fillRect(0, 0, w, 210);
        x.fillStyle = '#6cc04a'; x.fillRect(0, 210, w, h - 210);
        x.fillStyle = '#ffd23f'; x.beginPath(); x.arc(440, 70, 38, 0, 7); x.fill();
        x.strokeStyle = '#ffd23f'; for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; x.beginPath(); x.moveTo(440 + Math.cos(a) * 48, 70 + Math.sin(a) * 48); x.lineTo(440 + Math.cos(a) * 66, 70 + Math.sin(a) * 66); x.stroke(); }
        x.fillStyle = '#e63946'; x.strokeStyle = '#7a1b22'; x.fillRect(90, 150, 260, 80); x.strokeRect(90, 150, 260, 80);
        x.fillRect(300, 115, 80, 115); x.strokeRect(300, 115, 80, 115);
        x.fillStyle = '#bfe6ff'; x.fillRect(318, 130, 46, 38);
        x.strokeStyle = '#9aa0a6'; x.beginPath(); x.moveTo(100, 140); x.lineTo(290, 105); x.stroke();
        for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(110 + i * 32, 137 - i * 6); x.lineTo(118 + i * 32, 118 - i * 6); x.stroke(); }
        x.fillStyle = '#222'; [140, 320].forEach((cx) => { x.beginPath(); x.arc(cx, 235, 26, 0, 7); x.fill(); });
        x.fillStyle = '#2a7de1'; x.font = 'bold 34px Comic Sans MS, cursive'; x.fillText('RAVI', 30, 310);
      });
      const bajaArt = drawing(256, 320, (x, w, h) => {
        x.fillStyle = '#c97b45'; x.fillRect(0, 200, w, h - 200);
        x.strokeStyle = '#3b6fd8'; x.strokeRect(60, 110, 140, 80); x.beginPath(); x.moveTo(60, 110); x.lineTo(110, 70); x.lineTo(200, 110); x.stroke();
        x.fillStyle = '#222'; [75, 190].forEach((cx) => { x.beginPath(); x.arc(cx, 200, 30, 0, 7); x.fill(); });
        x.fillStyle = '#ffd23f'; x.font = 'bold 54px Comic Sans MS, cursive'; x.fillText('13', 100, 170);
        x.fillStyle = '#7a3d12'; x.font = 'bold 26px Comic Sans MS, cursive'; x.fillText('BAJA', 90, 290);
      });
      placeGLB(KK('frame_A_large'), { scene: Q, x: 168, y: -10, z: -72.6, length: 22, onLoad: setPicture(truckArt) });
      placeGLB(KK('frame_B'), { scene: Q, x: 200, y: -12, z: -72.6, length: 10, onLoad: setPicture(bajaArt) });
      placeGLB(KK('guitarcase'), { scene: Q, x: 236, z: -55, rotY: -Math.PI / 2, rotX: -0.12, height: 16, collider: { r: 3, h: 16 }, name: 'CASE DE VIOLÃO' });
      placeGLB(KK('sled'), { scene: Q, x: 205, z: 72, rotY: 0.6, length: 14, collider: { r: 5, box: { hx: 3.5, hz: 7 }, boxRot: 0.6, h: 4 }, name: 'TRENÓ' });
      placeGLB(KK('bicycle_helmet'), { scene: Q, x: 172, z: 66, rotY: 2.2, height: 6, collider: { r: 3.5, h: 6 }, name: 'CAPACETE' });
      placeGLB(KK('pickle_jar'), { scene: Q, x: 222, z: -12, rotY: 0.4, height: 6, collider: { r: 2.2, h: 6 }, name: 'POTE DE PICLES' });
    }
    placeKenney('furniture-kit', 'bear', { x: 114, z: -1, y: FLOOR_SURFACE_Y + 11, rotY: -Math.PI / 2, scale: 9 });
    function updateKenneyToys(time) {
      if (windmillBlades) windmillBlades.rotation.z = time * (0.8 + windState.strength * 1.6);
    }

    // ============================================================================
    // DETRITOS LEVES COM FÍSICA DE AR: papéis, post-its, clipes, palitos, gravetos e folhas.
    // O carrinho em movimento cria um deslocamento de ar (esteira): o que estiver perto é
    // empurrado para o lado e para cima, plana, tremula, gira e assenta de novo no chão.
    // ============================================================================
    const debrisPaperTex = (() => {
      const c = document.createElement('canvas'); c.width = 96; c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#fbfaf5'; x.fillRect(0, 0, 96, 128);
      x.strokeStyle = '#8ecae6'; x.lineWidth = 2;
      for (let y = 22; y < 128; y += 12) { x.beginPath(); x.moveTo(0, y); x.lineTo(96, y); x.stroke(); }
      x.strokeStyle = '#ff6b6b'; x.beginPath(); x.moveTo(16, 0); x.lineTo(16, 128); x.stroke();
      x.strokeStyle = '#3a3f47'; x.lineWidth = 1.5;
      for (let y = 34; y < 110; y += 12) { x.beginPath(); x.moveTo(22, y - 3); for (let k = 22; k < 60 + Math.random() * 30; k += 5) x.lineTo(k, y - 3 - Math.random() * 4); x.stroke(); }
      return new THREE.CanvasTexture(c);
    })();
    const DEBRIS_KINDS = {
      paper: { geo: new THREE.PlaneGeometry(2.0, 2.6).rotateX(-Math.PI / 2), mat: new THREE.MeshStandardMaterial({ map: debrisPaperTex, roughness: 0.85, side: THREE.DoubleSide }), max: 16, mass: 0.12, drag: 2.2, lift: 1.0, flutter: 1.0, fric: 3.5, rest: 0.03, breeze: 0.12 },
      postit: { geo: new THREE.BoxGeometry(1.5, 0.05, 1.5), mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }), max: 380, mass: 0.06, drag: 2.6, lift: 1.0, flutter: 1.0, fric: 3.0, rest: 0.04, breeze: 0.15 },
      clip: { geo: new THREE.TorusGeometry(0.35, 0.05, 6, 14).rotateX(-Math.PI / 2).scale(1.6, 1, 0.7), mat: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.25 }), max: 460, mass: 0.05, drag: 0.4, lift: 0.18, flutter: 0, fric: 7.0, rest: 0.06, bounce: 0.3, breeze: 0 },
      lid: { geo: new THREE.BoxGeometry(1, 0.3, 1), mat: new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.5 }), max: 8, mass: 0.35, drag: 0.5, lift: 0.3, flutter: 0.1, fric: 5.0, rest: 0.15, bounce: 0.35, breeze: 0 },
      stick: { geo: new THREE.BoxGeometry(2.2, 0.06, 0.32), mat: new THREE.MeshStandardMaterial({ color: 0xe3c08a, roughness: 0.7 }), max: 14, mass: 0.08, drag: 0.7, lift: 0.35, flutter: 0.2, fric: 6.0, rest: 0.04, bounce: 0.2, breeze: 0.05 },
      twig: { geo: new THREE.CylinderGeometry(0.06, 0.09, 2.2, 5).rotateZ(Math.PI / 2), mat: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.9 }), max: 24, mass: 0.15, drag: 0.6, lift: 0.3, flutter: 0.15, fric: 6.0, rest: 0.08, bounce: 0.2, breeze: 0.1 },
      leaf: { geo: new THREE.PlaneGeometry(0.95, 0.95).rotateX(-Math.PI / 2), mat: new THREE.MeshBasicMaterial({ map: leafTexture, alphaTest: 0.5, side: THREE.DoubleSide }), max: 130, mass: 0.03, drag: 3.2, lift: 1.2, flutter: 1.4, fric: 2.4, rest: 0.03, breeze: 1.0 }
    };
    const debrisItems = [];
    Object.entries(DEBRIS_KINDS).forEach(([name, k]) => {
      k.name = name;
      k.mesh = new THREE.InstancedMesh(k.geo, k.mat, k.max);
      // r128: setColorAt cria o buffer com o "count" atual; pré-aloca para todas as instâncias (branco = sem tinta)
      k.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(k.max * 3).fill(1), 3);
      k.mesh.count = 0;
      k.mesh.frustumCulled = false;
      k.mesh.castShadow = name === 'paper' || name === 'postit';
      k.mesh.receiveShadow = true;
      scene.add(k.mesh);
    });
    function debrisGround(it) {
      if (it.level === 'desk') {
        if (Math.abs(it.x) > DESK_HALF_W || Math.abs(it.z) > DESK_HALF_D) { it.level = 'floor'; }
        else return deskY(it.x, it.z);
      }
      return FLOOR_SURFACE_Y + Math.max(0, floorExtraHeight(it.x, it.z));
    }
    function addDebris(kind, x, z, opts = {}) {
      const k = DEBRIS_KINDS[kind];
      if ((x >= QUINTAL_MIN_X) !== IS_QUINTAL) return null; // cada cenário só cria os seus detritos
      if (!k || k.mesh.count >= k.max) return null;
      const it = {
        k, i: k.mesh.count++, x, z, y: 0, vx: 0, vy: 0, vz: 0, wy: 0, rx: 0, rz: 0,
        ry: opts.rotY !== undefined ? opts.rotY : Math.random() * Math.PI * 2, level: opts.level || (opts.floor ? 'floor' : 'desk'),
        ph: Math.random() * 20, sleep: false, home: opts.home || null, fade: 1,
        sx: opts.sx || 1, sz: opts.sz || 1
      };
      if (opts.vx || opts.vy || opts.vz) { it.vx = opts.vx || 0; it.vy = opts.vy || 0; it.vz = opts.vz || 0; it.wy = (Math.random() - 0.5) * 8; }
      it.y = (opts.y !== undefined ? opts.y : debrisGround(it) + k.rest) + (opts.lift || 0);
      if (opts.color !== undefined) { k.mesh.setColorAt(it.i, new THREE.Color(opts.color)); k.mesh.instanceColor.needsUpdate = true; }
      debrisItems.push(it);
      return it;
    }
    const _debrisObj = new THREE.Object3D();
    function writeDebrisMatrix(it) {
      _debrisObj.position.set(it.x, it.y, it.z);
      _debrisObj.rotation.set(it.rx, it.ry, it.rz);
      const fz = Math.max(0.001, it.fade);
      _debrisObj.scale.set(fz * it.sx, fz, fz * it.sz);
      _debrisObj.updateMatrix();
      it.k.mesh.setMatrixAt(it.i, _debrisObj.matrix);
      it.k.dirty = true;
    }
    function scatterDebris(kind, cx, cz, radius, count, opts = {}, colors = null) {
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
        addDebris(kind, cx + Math.cos(a) * r, cz + Math.sin(a) * r, Object.assign({}, opts, colors ? { color: colors[n % colors.length] } : {}));
      }
    }
    // Mesa: folhas de caderno, post-its, clipes soltos e palitos de picolé
    [[-50, 12, 0.3], [-56, 20, -0.4], [-46, 22, 1.2], [-60, 14, 2.0], [12, 26, 0.2], [18, 33, -0.6], [8, 34, 1.4], [-30, -22, 0.8]].forEach(([x, z, r]) => addDebris('paper', x, z, { rotY: r }));
    [[-10, 13.5, 0xffeb3b], [-7, 14.1, 0xff4081], [-4, 13.5, 0x00e5ff], [-2, 8.5, 0xffeb3b], [2, -4, 0x7ee787], [5, -5.5, 0xff4081], [-34, 30, 0x00e5ff], [26, 24, 0xffb703]].forEach(([x, z, c]) => addDebris('postit', x, z, { color: c, rotY: (Math.random() - 0.5) * 0.6 }));
    const CLIP_TINTS = [0xff4d6d, 0x3a86ff, 0x7ee787, 0xffbe0b, 0xb56cff, 0xc0c4cc];
    scatterDebris('clip', -16, 29, 4, 10, {}, CLIP_TINTS);
    scatterDebris('clip', 32, 0, 4, 10, {}, CLIP_TINTS);
    scatterDebris('stick', -28, -18, 4, 7);
    scatterDebris('stick', 22, 16, 3.5, 6);
    // Quarto: papéis perto do cesto e embaixo da mesa
    [[40, -58], [48, -56], [52, -60], [-20, -52], [-26, -48], [30, -30], [-60, -10], [70, 30]].forEach(([x, z]) => addDebris('paper', x, z, { floor: true }));
    // Ilha da Fogueira: muitas folhas e gravetos (voltam para a ilha se o vento levar para longe)
    const LEAF_TINTS = [0x6cbf3b, 0xa7e05a, 0xffc65a, 0xff8f3d, 0xc0392b, 0x8fbf3b];
    const campHome = { x: 152, z: 70, r: 10 };
    for (let n = 0; n < (IS_QUINTAL ? 80 : 0); n++) {
      const a = Math.random() * Math.PI * 2, r = 3.2 + Math.random() * 6.5;
      addDebris('leaf', 152 + Math.cos(a) * r, 70 + Math.sin(a) * r, { floor: true, color: LEAF_TINTS[n % LEAF_TINTS.length], home: campHome });
    }
    for (let n = 0; n < (IS_QUINTAL ? 16 : 0); n++) {
      const a = Math.random() * Math.PI * 2, r = 3.4 + Math.random() * 5.5;
      addDebris('twig', 152 + Math.cos(a) * r, 70 + Math.sin(a) * r, { floor: true, home: campHome });
    }
    // Folhas e gravetos espalhados pela floresta do rally
    rallyTreeSpots.slice(0, 12).forEach(([x, z], i) => {
      for (let n = 0; n < 6; n++) {
        const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 5;
        addDebris(n === 5 ? 'twig' : 'leaf', x + Math.cos(a) * r, z + Math.sin(a) * r, { floor: true, color: LEAF_TINTS[(n + i) % LEAF_TINTS.length], home: { x, z, r: 7 } });
      }
    });
    Object.values(DEBRIS_KINDS).forEach((k) => { if (k.mesh.instanceColor) k.mesh.instanceColor.needsUpdate = true; });
    debrisItems.forEach(writeDebrisMatrix);

    // Caixinha estourando: clipes voam para todo lado; post-its saem para o lado em que a caixa foi jogada
    const NOTE_TINTS = [0xffeb3b, 0xff4081, 0x00e5ff, 0x7ee787, 0xffb703, 0xb56cff];
    function burstBox(obs, dirX, dirZ, power) {
      const b = obs.burstBox;
      if (!b || b.empty || !obs.group) return;
      b.empty = true;
      const gp = obs.group.position, level = obs.level;
      const dl = Math.hypot(dirX, dirZ) || 1;
      dirX /= dl; dirZ /= dl;
      const base = Math.atan2(dirZ, dirX), top = gp.y + (obs.h || 1.5);
      const sp = 4 + Math.min(1, power) * 8;
      if (b.kind === 'clip') {
        const cb = b.item.clipBox;
        const n = Math.max(12, Math.round(cb.count * 0.6));
        cb.count = 0;
        updateClipPile(cb);
        for (let i = 0; i < n; i++) {
          const a = Math.random() < 0.6 ? base + (Math.random() - 0.5) * 2.2 : Math.random() * Math.PI * 2;
          const v = sp * (0.35 + Math.random() * 0.8);
          addDebris('clip', gp.x + Math.cos(a) * 0.8, gp.z + Math.sin(a) * 0.8, { level, y: top, color: CLIP_TINTS[i % CLIP_TINTS.length], vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 3 + Math.random() * 6 });
        }
        showCarSpeech('Choveu clipe! 📎', 2000);
        logInteractionEvent('📎 A caixinha de clipes abriu e espalhou clipes para todo lado!');
      } else {
        const d = b.dims;
        b.lid.visible = false;
        addDebris('lid', gp.x, gp.z, { level, y: top + 0.2, sx: d.w * 1.04, sz: d.d * 1.04, vx: dirX * sp * 0.7, vz: dirZ * sp * 0.7, vy: 7 + Math.random() * 3 });
        for (let i = 0; i < 50; i++) {
          const a = base + (Math.random() - 0.5) * 1.6;
          const v = sp * (0.3 + Math.random() * 0.9);
          addDebris('postit', gp.x + Math.cos(a), gp.z + Math.sin(a), { level, y: top - 0.3, color: NOTE_TINTS[i % NOTE_TINTS.length], vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 2 + Math.random() * 5 });
        }
        showCarSpeech('Bum! Post-it para todo lado! 🗒️', 2200);
        logInteractionEvent('🗒️ A caixinha de post-its estourou e espalhou 50 folhinhas!');
      }
      if (!(sfx('plank', { vol: 0.65 }) && sfx(b.kind === 'clip' ? 'hitMetal' : 'paper', { vol: 0.7, delay: 0.05 }))) {
        playTone(520, 0, 0.08, 'square', 0.05); playTone(260, 0.05, 0.16, 'triangle', 0.05);
      }
      rumble(0.35, 0.6, 140);
    }
    function updateDebris(time, dt) {
      dt = Math.min(dt, 0.05);
      const cp = vehicle.position;
      const dirS = carSpeed >= 0 ? 1 : -1;
      const hx = Math.sin(carAngle) * dirS, hz = Math.cos(carAngle) * dirS;
      const spd = Math.abs(carSpeed) * 60; // unidades por segundo
      const ws = windState.strength;
      for (let n = 0; n < debrisItems.length; n++) {
        const it = debrisItems[n], k = it.k;
        // 1. Esteira de ar do carrinho
        const dx = it.x - cp.x, dz = it.z - cp.z;
        let pushed = false;
        if (spd > 2.5 && dx * dx + dz * dz < 100 && Math.abs(it.y - cp.y) < 3.5) {
          const d = Math.hypot(dx, dz), R = 2.6 + spd * 0.16;
          if (d < R) {
            const fall = (1 - d / R) * (1 - d / R);
            const along = dx * hx + dz * hz;
            let sx = dx - hx * along, sz = dz - hz * along;
            const sl = Math.hypot(sx, sz) || 1;
            sx /= sl; sz /= sl;
            const a = spd * fall * 0.32 / Math.max(k.mass, 0.04);
            it.vx += (sx * 0.85 + hx * 0.45) * a * dt;
            it.vz += (sz * 0.85 + hz * 0.45) * a * dt;
            it.vy += a * 0.33 * k.lift * dt;
            it.wy += (Math.random() - 0.5) * a * 0.5 * dt;
            if (d < 1.9 && along > -0.5) { // atropelado pelo para-choque: sai com a velocidade do carrinho
              it.vx += hx * spd * 0.5 * dt * 10; it.vz += hz * spd * 0.5 * dt * 10;
              it.vy = Math.max(it.vy, 2 + spd * 0.12 * k.lift);
            }
            const v = Math.hypot(it.vx, it.vz);
            if (v > 16) { it.vx *= 16 / v; it.vz *= 16 / v; }
            it.sleep = false;
            pushed = true;
          }
        }
        const ground = debrisGround(it) + k.rest;
        const air = it.y > ground + 0.02;
        // 2. Brisa (só no chão do quarto, e só para quem é leve o bastante)
        if (k.breeze > 0 && it.level === 'floor') {
          const gustLocal = ws * (0.55 + 0.45 * Math.sin(time * 1.7 + it.ph)) * (0.7 + 0.3 * Math.sin(time * 0.43 + it.x * 0.05));
          const f = air ? gustLocal * 3.2 : Math.max(0, gustLocal - 0.62) * 9;
          if (f > 0.01) {
            it.vx += windState.x * f * k.breeze * dt;
            it.vz += windState.z * f * k.breeze * dt;
            if (!air && f > 1.5 && Math.random() < k.breeze * dt * 0.8) it.vy += 1.4 + Math.random() * 1.6; // folha levantada pela rajada
            it.sleep = false;
          }
        }
        if (it.sleep && !pushed) continue;
        // 3. Integração: no ar plana e tremula; no chão desliza com atrito e assenta deitado
        if (air || it.vy > 0) {
          it.vy -= 9.8 * 0.9 * dt;
          const dr = Math.exp(-k.drag * dt);
          it.vx *= dr; it.vz *= dr;
          if (it.vy < 0) it.vy *= Math.exp(-k.drag * 1.3 * dt);
          if (k.flutter > 0) {
            it.vx += Math.cos(time * 4.1 + it.ph) * k.flutter * 3 * dt;
            it.vz += Math.sin(time * 3.3 + it.ph) * k.flutter * 3 * dt;
            it.rx = Math.sin(time * 5 + it.ph) * 0.7 * k.flutter;
            it.rz = Math.cos(time * 4.2 + it.ph) * 0.6 * k.flutter;
          } else {
            it.rx += 6 * dt; it.rz += 4 * dt;
          }
        } else {
          const fr = Math.exp(-k.fric * dt);
          it.vx *= fr; it.vz *= fr;
          it.rx += (0 - it.rx) * Math.min(1, dt * 10);
          it.rz += (0 - it.rz) * Math.min(1, dt * 10);
        }
        it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
        it.ry += it.wy * dt;
        it.wy *= Math.exp(-2.2 * dt);
        const g2 = debrisGround(it) + k.rest;
        if (it.y <= g2) {
          it.y = g2;
          if (it.vy < -3 && k.bounce) it.vy = -it.vy * k.bounce;
          else it.vy = 0;
        }
        // Paredes do quarto e obstáculos fixos (empurra para fora)
        if (it.level === 'floor') {
          it.x = clamp(it.x, BOUNDS.minX + 1, BOUNDS.maxX - 1); it.z = clamp(it.z, BOUNDS.minZ + 1, BOUNDS.maxZ - 1);
          if (it.y - g2 < 1.5) {
            ensureStaticGrid();
            const nearS = [];
            forEachNear(staticGrid, 'floor', it.x, it.z, 1, (st) => { nearS.push(st); });
            for (let o = 0; o < nearS.length; o++) {
              const s = nearS[o];
              if (s._dyn || s.level !== 'floor' || s.r < 0.6 || s.box || s.y0 !== undefined) continue;
              const ox = it.x - s.x, oz = it.z - s.z, od = ox * ox + oz * oz;
              if (od < s.r * s.r && od > 1e-6) {
                const d2 = Math.sqrt(od);
                it.x = s.x + ox / d2 * s.r; it.z = s.z + oz / d2 * s.r;
                const vn = it.vx * ox / d2 + it.vz * oz / d2;
                if (vn < 0) { it.vx -= 1.3 * vn * ox / d2; it.vz -= 1.3 * vn * oz / d2; }
              }
            }
          }
        }
        // Folhas da ilha que o vento levou longe demais: somem e caem de novo sobre a ilha
        if (it.home) {
          const hd = Math.hypot(it.x - it.home.x, it.z - it.home.z);
          if (hd > it.home.r + 8 || it.respawning) {
            it.respawning = true;
            it.fade -= dt * 1.5;
            if (it.fade <= 0) {
              const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * (it.home.r - 3);
              it.x = it.home.x + Math.cos(a) * r; it.z = it.home.z + Math.sin(a) * r;
              it.y = debrisGround(it) + 5 + Math.random() * 4;
              it.vx = it.vz = it.vy = 0;
              it.fade = 1; it.respawning = false;
            }
          }
        }
        if (!air && !pushed && it.vx * it.vx + it.vz * it.vz < 0.0004 && Math.abs(it.wy) < 0.02 && it.vy === 0 && Math.abs(it.rx) < 0.01) it.sleep = true;
        writeDebrisMatrix(it);
      }
      Object.values(DEBRIS_KINDS).forEach((k) => { if (k.dirty) { k.mesh.instanceMatrix.needsUpdate = true; k.dirty = false; } });
    }

    // Grama solta na margem do lago e perto das árvores do chão
    (function shoreGrass() {
      const pts = [];
      for (let i = 0; i < 2600; i++) {
        const a = Math.random() * Math.PI * 2;
        const f = lakeRadiusFactor(a) * (1.14 + Math.random() * 0.35);
        const x = LAKE.x + Math.cos(a) * LAKE.rx * f, z = LAKE.z + Math.sin(a) * LAKE.rz * f;
        if (z > 92 || x > 122) continue;
        pts.push({ x, y: FLOOR_SURFACE_Y, z, h: 0.5 + Math.random() * 0.8 });
      }
      createGrassPatch(pts);
    })();

    // --- Posto do Bombeiro ---
    const fireStation = (() => {
      const g = new THREE.Group();
      g.position.set(-124, ISLAND_Y, 82);
      g.rotation.y = 0.35;
      const red = new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.6 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 7), red);
      body.position.y = 4;
      body.castShadow = true; body.receiveShadow = true;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 8), new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.5 }));
      roof.position.y = 8.5;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(6, 5.4), new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.5 }));
      door.position.set(0, 2.7, 3.51);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.6), new THREE.MeshBasicMaterial({ map: createDsLabelTexture('BOMBEIROS', { trigger: true, width: 512, height: 100 }) }));
      sign.position.set(0, 6.6, 3.52);
      g.add(body, roof, door, sign);
      scene.add(g);
      obstacles.push({ x: -124, z: 82, r: 5, box: { hx: 5.6, hz: 3.6 }, boxRot: 0.35, h: 9, name: 'POSTO DO BOMBEIRO', isStatic: true, level: 'floor' });
      return g;
    })();
    placeModel('brick_flemish_bond', { x: -114, z: 88, y: ISLAND_Y, rotY: -0.3, isStatic: true, r: 4.2, name: 'Muro de Tijolos' });
    placeModel('health_pickup', { x: -116, z: 74, y: ISLAND_Y + 2.2, physics: false, name: 'Kit de Primeiros Socorros',
      onLoad: (m) => floatingProps.push({ obj: m, baseY: ISLAND_Y + 2.2, spin: 1.1, bob: 0.3, phase: 2 }) });
    placeModel('traffic_cone_01', { x: -112, z: 74, y: ISLAND_Y, name: 'Cone do Posto', scale: 1.3 });
    placeModel('rounded_picket_fence', { x: -131, z: 69, y: ISLAND_Y, rotY: 0.6, isStatic: true, r: 2, name: 'Cerquinha do Posto' });

    // --- Ilha Espacial ---
    let spaceRocket = null;
    placeModel('rocket_toy_02', { x: -142, z: -60, y: ISLAND_Y, isStatic: true, r: 2.2, name: 'Foguete Espacial', onLoad: (m) => { spaceRocket = m; } });
    placeModel('crystal', { x: -134, z: -64, y: ISLAND_Y, isStatic: true, r: 1, name: 'Cristal Lunar', scale: 1.6 });
    placeModel('crystal', { x: -147, z: -52, y: ISLAND_Y, isStatic: true, r: 1, name: 'Cristal Lunar', scale: 1.2, rotY: 1 });
    placeModel('globe', { x: -132, z: -57, y: ISLAND_Y, isStatic: true, r: 1.6, name: 'Globo Terrestre' });
    placeModel('crescent_moon', { x: -146, z: -58, y: ISLAND_Y + 21, physics: false,
      onLoad: (m) => floatingProps.push({ obj: m, baseY: ISLAND_Y + 21, spin: 0.4, bob: 0.6, phase: 1 }) });
    [[-136, -50, 17], [-152, -62, 19], [-130, -66, 15]].forEach(([sx, sz, sy], i) => {
      placeModel('star_01', { x: sx, z: sz, y: ISLAND_Y + sy, physics: false, scale: 0.6 + i * 0.15,
        onLoad: (m) => floatingProps.push({ obj: m, baseY: ISLAND_Y + sy, spin: 0.9, bob: 0.4, phase: i * 2 }) });
    });

    // --- Ilha da Música ---
    placeModel('piano', { x: 110, z: -46, y: ISLAND_Y, rotY: -Math.PI / 2, isStatic: true, r: 4.5, name: 'Piano de Brinquedo' });
    placeModel('guitar_stand', { x: 101, z: -52, y: ISLAND_Y, rotY: 0.4, physics: false });
    placeModel('electric_guitar', { x: 101, z: -52.4, y: ISLAND_Y + 1.6, rotY: 0.4, innerRot: [-0.18, 0, 0], isStatic: true, r: 1.6, name: 'Guitarra' });
    placeModel('computer_speaker_01', { x: 108, z: -37, y: ISLAND_Y, rotY: -2.4, isStatic: true, r: 1.2 });
    placeModel('computer_speaker_01', { x: 113, z: -40, y: ISLAND_Y, rotY: -2.1, isStatic: true, r: 1.2 });
    placeModel('japanese_stone_lantern_01', { x: 97, z: -53, y: ISLAND_Y, isStatic: true, r: 1.4 });

    // --- Ilha dos Brinquedos ---
    [[-58, 72, 0xe63946, 0.3], [-54, 69, 0x3a86ff, 1.2], [-60, 76, 0xffc300, 2.1]].forEach(([dx, dz, tint, rot]) => {
      placeModel('d6_dice', { x: dx, z: dz, y: ISLAND_Y, rotY: rot, tint, name: 'Dado Gigante' });
    });
    placeModel('skateboard_setup', { x: -50, z: 84, y: ISLAND_Y, rotY: 0.5, name: 'Skate' });
    placeModel('rocket_toy_01', { x: -44, z: 80, y: ISLAND_Y, name: 'Foguetinho do Ravi' });
    placeModel('pacifier_01', { x: -48, z: 76, y: ISLAND_Y, rotY: 1.1, name: 'Chupeta do Ravi' });
    placeModel('cushion_01', { x: -57, z: 84, y: ISLAND_Y, tint: 0x8ecae6, name: 'Almofada' });
    [[-62, 80, 0xe63946, 0.4], [-52, 88, 0x2a9d8f, 1.7], [-41, 76, 0xffb703, 2.6]].forEach(([jx, jz, tint, rot]) => {
      placeModel('jigsaw_piece', { x: jx, z: jz, y: ISLAND_Y + 0.02, rotY: rot, physics: false, tint });
    });
    placeModel('volleyball', {
      x: -30, z: 66, floor: true, name: 'Bola do Ravi', mass: 0.5,
      onLoad: (m) => {
        // Pivô no centro da bola para ela rolar em vez de balançar pela base
        const inner = m.children[0], half = m.userData.dims.h / 2;
        inner.position.y = half;
        inner.children.forEach(c => { c.position.y -= half; });
        m.userData.rolls = true;
        const o = m.userData.obs;
        // Bola de vôlei: leve e elástica, colisor do tamanho real da bola
        if (o) {
          o.ball = true; o.canTopple = false; o.box = null;
          o.r = half * 0.98; o.h = half * 2;
          o.mass = 0.32; o.restitution = 0.72; o.friction = 0.986; o.bounce = 0.62; o.wallE = 0.75; o.lift = 0.55;
        }
        // Bolas não são "pegáveis": só rolam e quicam quando empurradas (como o boliche do DS)
        for (let i = grabbableItems.length - 1; i >= 0; i--) if (grabbableItems[i].group === m) grabbableItems.splice(i, 1);
      }
    });

    // --- Lago e Ilha do Lago ---
    placeModel('flower_pot_01', { x: 77, z: 75, y: ISLAND_Y, scale: 0.45, isStatic: true, r: 1.3, name: 'Vasinho' });
    placeModel('mushroom_01', { x: 83, z: 71, y: ISLAND_Y, isStatic: true, r: 1.5 });
    placeModel('mushroom_03', { x: 75, z: 70, y: ISLAND_Y, isStatic: true, r: 1.5, rotY: 1 });
    placeModel('mushroom_02', { x: -52, z: 90, y: ISLAND_Y, isStatic: true, r: 1.3 });
    placeModel('mushroom_01', { x: -126, z: 70, y: ISLAND_Y, isStatic: true, r: 1.5, rotY: 2 });
    placeModel('park_bench', { x: 100, z: 52, floor: true, rotY: Math.PI, isStatic: true, r: 3.5, name: 'Banco do Lago' });
    placeModel('japanese_stone_lantern_01', { x: 98, z: 58, floor: true, isStatic: true, r: 1.4 });
    placeModel('rock_01', { x: 95, z: 86, floor: true, isStatic: true, r: 3 });
    placeModel('rock_02', { x: 58, z: 56, floor: true, rotY: 0.8, isStatic: true, r: 3.2 });
    let lakeBoat = null;
    placeModel('wooden_boat_01', { x: 66, z: 78, y: FLOOR_SURFACE_Y + 0.05, rotY: 1.1, physics: false, name: 'Barquinho', onLoad: (m) => { lakeBoat = m; } });

    // ============================================================================
    // MÓVEIS DO QUARTO (cama, janela, porta, estante, cômoda, TV, quadros, postes)
    // ============================================================================
    // Cama do Ravi (procedural) encostada na parede direita
    const kidBed = (() => {
      const g = new THREE.Group();
      g.position.set(109, FLOOR_SURFACE_Y, 15);
      const wood = new THREE.MeshStandardMaterial({ color: 0xc68b59, roughness: 0.7 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(26, 5, 54), wood);
      frame.position.y = 2.5;
      const head = new THREE.Mesh(new THREE.BoxGeometry(26, 16, 2), wood);
      head.position.set(0, 8, -27);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 2), wood);
      foot.position.set(0, 4.5, 27);
      const mattress = new THREE.Mesh(new THREE.BoxGeometry(24, 4, 51), new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.9 }));
      mattress.position.y = 7;
      // Cobertor com estampa de carrinhos e estrelas
      const blanketCanvas = document.createElement('canvas');
      blanketCanvas.width = 256; blanketCanvas.height = 512;
      const bctx = blanketCanvas.getContext('2d');
      bctx.fillStyle = '#3a86ff'; bctx.fillRect(0, 0, 256, 512);
      for (let i = 0; i < 28; i++) {
        bctx.fillStyle = ['#ffd166', '#ffffff', '#ff6a7c', '#d5ff95'][i % 4];
        const x = (i * 97) % 240 + 8, y = (i * 61) % 500 + 6;
        bctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const r = k % 2 ? 5 : 11, a = k * Math.PI / 5 - Math.PI / 2;
          bctx[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        bctx.fill();
      }
      bctx.fillStyle = '#ffffff'; bctx.fillRect(0, 0, 256, 26);
      const blanket = new THREE.Mesh(new THREE.BoxGeometry(25, 1.2, 36), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(blanketCanvas), roughness: 0.95 }));
      blanket.position.set(0, 9.4, 7.5);
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(16, 2.6, 7), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }));
      pillow.position.set(0, 10.2, -21);
      [frame, head, foot, mattress, blanket, pillow].forEach((m) => { m.castShadow = true; m.receiveShadow = true; g.add(m); });
      scene.add(g);
      g.traverse((m) => { if (m.isMesh) occluderMeshes.push(m); });
      obstacles.push({ x: 109, z: 15, r: 12, box: { hx: 13.2, hz: 28 }, boxRot: 0, h: 11, name: 'CAMA DO RAVI', isStatic: true, level: 'floor' });
      return g;
    })();
    placeModel('cushion_01', { x: 103, z: -3, y: FLOOR_SURFACE_Y + 11, physics: false, tint: 0xffd166, rotY: 0.4 });
    placeModel('bedside_table_01', { x: 111, z: -21, floor: true, rotY: -Math.PI / 2, isStatic: true, r: 4.6, name: 'Criado-mudo' });
    placeModel('desk_lamp', { x: 113, z: -19, y: FLOOR_SURFACE_Y + 16, rotY: -2, physics: false, name: 'Abajur' });

    // Janela com céu, nuvens e cortinas (parede direita)
    (function createWindow() {
      const g = new THREE.Group();
      g.position.set(237.9, -4, -30); // na parede leste (antes ficava solta no meio do quarto expandido)
      g.rotation.y = -Math.PI / 2;
      const sky = document.createElement('canvas');
      sky.width = 256; sky.height = 192;
      const sctx = sky.getContext('2d');
      const grad = sctx.createLinearGradient(0, 0, 0, 192);
      grad.addColorStop(0, '#5fc8ff'); grad.addColorStop(1, '#d9f4ff');
      sctx.fillStyle = grad; sctx.fillRect(0, 0, 256, 192);
      sctx.fillStyle = '#ffe14d'; sctx.beginPath(); sctx.arc(200, 44, 22, 0, Math.PI * 2); sctx.fill();
      sctx.fillStyle = '#ffffff';
      [[60, 60, 1], [130, 110, 0.8], [40, 140, 0.7]].forEach(([cx, cy, s]) => {
        [[0, 0, 18], [16, -6, 14], [-16, -4, 13], [30, 4, 12]].forEach(([ox, oy, r]) => {
          sctx.beginPath(); sctx.arc(cx + ox * s, cy + oy * s, r * s, 0, Math.PI * 2); sctx.fill();
        });
      });
      sctx.fillStyle = '#52b788'; sctx.beginPath(); sctx.ellipse(128, 205, 170, 40, 0, 0, Math.PI * 2); sctx.fill();
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(30, 22), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sky) }));
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
      const bars = [[0, 11.5, 32, 1.4], [0, -11.5, 32, 1.4], [-15.5, 0, 1.4, 24], [15.5, 0, 1.4, 24], [0, 0, 0.8, 22], [0, 0, 30, 0.8]];
      bars.forEach(([x, y, w, h]) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.8), frameMat);
        b.position.set(x, y, 0.3);
        g.add(b);
      });
      const curtainMat = new THREE.MeshStandardMaterial({ color: 0x8ecae6, roughness: 0.9, side: THREE.DoubleSide });
      [-1, 1].forEach((side) => {
        const cg = new THREE.PlaneGeometry(9, 28, 12, 1);
        const cp = cg.attributes.position;
        for (let i = 0; i < cp.count; i++) cp.setZ(i, Math.sin(cp.getX(i) * 1.6) * 0.6);
        cg.computeVertexNormals();
        const curtain = new THREE.Mesh(cg, curtainMat);
        curtain.position.set(side * 18.5, -1, 1.2);
        g.add(curtain);
      });
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 46, 10), new THREE.MeshStandardMaterial({ color: 0x2b2e35, metalness: 0.5, roughness: 0.4 }));
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, 13.5, 1.4);
      g.add(glass, rod);
      g.userData.quarto = true;
      scene.add(g);
      const sunLight = new THREE.PointLight(0xfff1d0, 0.5, 70, 2);
      sunLight.position.set(225, -2, -30);
      scene.add(sunLight);
    })();

    // Porta na parede da frente, estante e cômoda com TV na parede do fundo
    // (a porta da frente agora é um vão aberto com popup: ver PORTAS ENTRE CENÁRIOS)
    placeModel('medieval_bookcase', { x: 70, z: -69, floor: true, isStatic: true, r: 4.5, name: 'Estante' });
    // Estante: tábuas em y -5.9 (topo), -13.02, -20.13 e -27.25; vão útil de ~7; largura x 57–83, fundo z -73..-65
    const SHELF_Y = [-5.9, -13.02, -20.13, -27.25];
    placeModel('globe', { x: 61.5, z: -69, y: SHELF_Y[0], scale: 0.86, physics: false, name: 'Globo da Estante' });
    (function shelfBooks() {
      // Fileiras de livros coloridos (paleta do DS), com um livro inclinado no fim de cada fileira
      const colors = [0xe63946, 0xffb703, 0x2a9d8f, 0x3a86ff, 0xff8fab, 0x8338ec, 0xfb8500, 0x06d6a0, 0xf4f1de];
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      function bookRow(x0, x1, y, count) {
        let x = x0;
        for (let i = 0; i < count && x < x1; i++) {
          const w = 0.55 + rnd() * 0.45, h = 4.2 + rnd() * 1.9, d = 3.4 + rnd() * 0.8;
          const book = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: colors[Math.floor(rnd() * colors.length)], roughness: 0.7 }));
          const last = i === count - 1;
          book.position.set(x + w / 2 + (last ? h * 0.18 : 0), y + h / 2 - (last ? h * 0.03 : 0), -69 + (rnd() - 0.5) * 0.4);
          if (last) book.rotation.z = -0.32;
          // Faixa clara na lombada
          const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.28, 0.05), new THREE.MeshStandardMaterial({ color: 0xfff3d6, roughness: 0.6 }));
          band.position.set(0, h * 0.25, d / 2 + 0.01);
          book.add(band);
          book.castShadow = true;
          scene.add(book);
          x += w + 0.05;
        }
      }
      bookRow(66, 74, SHELF_Y[0], 9);
      bookRow(58, 66.5, SHELF_Y[1], 10);
      bookRow(73, 82, SHELF_Y[2], 9);
      bookRow(58, 63, SHELF_Y[3], 6);
    })();
    placeModel('flower_pot_01', { x: 79, z: -69, y: SHELF_Y[0], scale: 0.6, physics: false, name: 'Vasinho da Estante' });
    placeModel('rocket_toy_01', { x: 71, z: -69, y: SHELF_Y[1], rotY: 0.5, physics: false, name: 'Foguetinho da Estante' });
    placeModel('crystal', { x: 76.5, z: -68.5, y: SHELF_Y[1], scale: 1.3, physics: false, name: 'Cristal da Estante' });
    placeModel('d6_dice', { x: 80, z: -68, y: SHELF_Y[1], scale: 0.7, rotY: 0.6, physics: false, name: 'Dado da Estante' });
    placeModel('star_01', { x: 61, z: -69, y: SHELF_Y[2], scale: 0.7, physics: false, name: 'Estrela da Estante' });
    placeModel('storage_box_01', { x: 67.5, z: -69, y: SHELF_Y[2], scale: 0.9, physics: false, name: 'Caixinha da Estante' });
    placeModel('cardboard_box_01', { x: 70.5, z: -69, y: SHELF_Y[3], scale: 0.55, physics: false, name: 'Caixa de Brinquedos' });
    placeModel('volleyball', { x: 78, z: -69, y: SHELF_Y[3], scale: 0.5, physics: false, name: 'Bolinha da Estante' });
    placeModel('chest_of_drawers_01', { x: -100, z: -68, floor: true, isStatic: true, r: 5.5, name: 'Cômoda' });
    placeModel('retro_tv', { x: -100, z: -68, y: FLOOR_SURFACE_Y + 26, physics: false, name: 'TV Retrô' });
    // Relógio de parede grande (estilo DS: aro vermelho), números legíveis e ponteiros na hora exata do navegador
    const wallClock = (function createWallClock() {
      const R = 7.6, X = 0, Y = 11.5, Z = -72.6;
      const g = new THREE.Group();
      g.position.set(X, Y, Z);
      g.name = 'Relógio de Parede';
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.7, R + 0.7, 1.1, 48), new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.4 }));
      rim.rotation.x = Math.PI / 2;
      rim.position.z = 0.55;
      rim.castShadow = true;
      g.add(rim);
      // Mostrador desenhado em canvas: marcas de minuto, números grandes 1–12
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fffaf0'; ctx.beginPath(); ctx.arc(256, 256, 256, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 60; i++) {
        const a = i / 60 * Math.PI * 2, big = i % 5 === 0;
        ctx.strokeStyle = big ? '#2b1d2e' : '#9a8f9c'; ctx.lineWidth = big ? 8 : 3;
        ctx.beginPath();
        ctx.moveTo(256 + Math.sin(a) * (big ? 214 : 226), 256 - Math.cos(a) * (big ? 214 : 226));
        ctx.lineTo(256 + Math.sin(a) * 244, 256 - Math.cos(a) * 244);
        ctx.stroke();
      }
      ctx.fillStyle = '#120b14'; ctx.font = 'bold 66px Pally, "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let n = 1; n <= 12; n++) {
        const a = n / 12 * Math.PI * 2;
        ctx.fillText(String(n), 256 + Math.sin(a) * 172, 256 - Math.cos(a) * 172 + 3);
      }
      const face = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.6 }));
      face.position.z = 1.12;
      g.add(face);
      // Ponteiros (pivô no centro; geometria deslocada para girar pela ponta de trás)
      function hand(len, width, depth, color, z, back = 0.8) {
        const geo = new THREE.BoxGeometry(width, len + back, depth);
        geo.translate(0, (len - back) / 2, 0);
        // Material sem iluminação: ponteiros sempre bem escuros e nítidos, mesmo com a parede iluminada
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
        m.position.z = z;
        m.castShadow = true;
        g.add(m);
        return m;
      }
      const hourHand = hand(R * 0.52, 0.66, 0.16, 0x120b14, 1.25);
      const minuteHand = hand(R * 0.8, 0.44, 0.16, 0x120b14, 1.42);
      const secondHand = hand(R * 0.86, 0.16, 0.1, 0xd90429, 1.58, 1.6);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.5, 20), new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.3 }));
      hub.rotation.x = Math.PI / 2;
      hub.position.z = 1.6;
      g.add(hub);
      scene.add(g);
      return {
        update() {
          // Hora local do navegador, com milissegundos: ponteiro dos segundos anda suave e exato
          const d = new Date();
          const s = d.getSeconds() + d.getMilliseconds() / 1000;
          const m = d.getMinutes() + s / 60;
          const h = (d.getHours() % 12) + m / 60;
          secondHand.rotation.z = -s / 60 * Math.PI * 2;
          minuteHand.rotation.z = -m / 60 * Math.PI * 2;
          hourHand.rotation.z = -h / 12 * Math.PI * 2;
        }
      };
    })();
    wallClock.update();
    placeModel('painting_frame_01', { x: -66, z: -72.9, y: 4, physics: false, name: 'Quadro' });

    // Quadro da família na parede do fundo: moldura de madeira clara com a foto em assets/quadro-familia.jpg
    (function familyFrame() {
      const SIZE = 13, BAR = 0.8, X = -36, Y = 10.5, Z = -72.6; // acima do tampo da mesa, abaixo do teto
      const g = new THREE.Group();
      g.position.set(X, Y, Z);
      g.name = 'Quadro da Família';
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4f26, roughness: 0.75 });
      const outer = SIZE + BAR * 2;
      [[0, (SIZE + BAR) / 2, outer, BAR], [0, -(SIZE + BAR) / 2, outer, BAR],
       [(SIZE + BAR) / 2, 0, BAR, SIZE], [-(SIZE + BAR) / 2, 0, BAR, SIZE]].forEach(([x, y, w, h]) => {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.8), woodMat);
        bar.position.set(x, y, 0.4);
        bar.castShadow = true;
        g.add(bar);
      });
      const photoMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.55, metalness: 0 });
      const photo = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), photoMat);
      photo.position.z = 0.15;
      g.add(photo);
      // Enquanto a foto não existir, mostra uma moldura com aviso (em vez de um buraco preto)
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#efe6da'; ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = '#cdbfae'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(128, 8); ctx.lineTo(128, 248); ctx.moveTo(8, 128); ctx.lineTo(248, 128); ctx.stroke();
      ctx.fillStyle = '#9b8b7a'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('foto da família', 128, 122); ctx.fillText('em breve ❤', 128, 150);
      photoMat.map = new THREE.CanvasTexture(c);
      new THREE.TextureLoader().load('assets/quadro-familia.jpg', (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = 8;
        // Recorte só das 4 fotos (a imagem original mostra também a parede e a moldura real)
        const iw = tex.image.width, ih = tex.image.height;
        const crop = { x: 508 / 1599, y: 44 / 899, w: 800 / 1599, h: 816 / 899 }; // frações da imagem
        tex.repeat.set(crop.w, crop.h);
        tex.offset.set(crop.x, 1 - crop.y - crop.h);
        if (Math.abs(iw / ih - 1599 / 899) > 0.05) { // outra foto: recorte quadrado central
          const s = Math.min(iw, ih);
          tex.repeat.set(s / iw, s / ih);
          tex.offset.set((1 - s / iw) / 2, (1 - s / ih) / 2);
        }
        photoMat.map = tex;
        photoMat.needsUpdate = true;
      }, undefined, () => { /* sem foto ainda: fica o aviso */ });
      // Plaquinha embaixo da moldura
      const pc = document.createElement('canvas');
      pc.width = 512; pc.height = 96;
      const pctx = pc.getContext('2d');
      pctx.fillStyle = '#c9a25b'; pctx.fillRect(0, 0, 512, 96);
      pctx.strokeStyle = '#8a6a2f'; pctx.lineWidth = 6; pctx.strokeRect(3, 3, 506, 90);
      pctx.fillStyle = '#3b2a12'; pctx.font = 'bold 44px Pally, sans-serif'; pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
      pctx.fillText('Papai · Mamãe · Ravi', 256, 50);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(7, 1.3, 0.2), [
        woodMat, woodMat, woodMat, woodMat,
        new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(pc), roughness: 0.4, metalness: 0.3 }), woodMat
      ]);
      plate.position.set(0, -(SIZE / 2 + BAR + 1.3), 0.2);
      g.add(plate);
      scene.add(g);
    })();
    (function kidDrawing() {
      // Desenho do Ravi dentro da moldura
      const c = document.createElement('canvas');
      c.width = 256; c.height = 176;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fffdf5'; ctx.fillRect(0, 0, 256, 176);
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffc300'; ctx.beginPath(); ctx.arc(210, 38, 20, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.beginPath(); ctx.moveTo(210 + Math.cos(a) * 26, 38 + Math.sin(a) * 26); ctx.lineTo(210 + Math.cos(a) * 36, 38 + Math.sin(a) * 36); ctx.stroke(); }
      ctx.fillStyle = '#ff4518'; ctx.fillRect(50, 100, 100, 40);
      ctx.fillStyle = '#5fc8ff'; ctx.fillRect(110, 106, 30, 18);
      ctx.fillStyle = '#222'; [[75, 145], [130, 145]].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill(); });
      ctx.strokeStyle = '#ffd166'; ctx.beginPath(); ctx.moveTo(60, 100); ctx.lineTo(140, 80); ctx.stroke();
      ctx.strokeStyle = '#52b788'; ctx.beginPath(); ctx.moveTo(0, 160); ctx.lineTo(256, 160); ctx.stroke();
      ctx.fillStyle = '#3a86ff'; ctx.font = '700 22px "Amatic SC", sans-serif'; ctx.fillText('RAVI', 20, 40);
      const art = new THREE.Mesh(new THREE.PlaneGeometry(13.2, 8.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
      art.position.set(-66, 4 + 5.4, -72.4);
      scene.add(art);
    })();
    placeModel('office_chair', { x: 22, z: 76, floor: true, rotY: Math.PI - 0.5, isStatic: true, r: 7, name: 'Cadeira de Escritório' });
    placeModel('cardboard_box_01', { x: -161, z: 80, floor: true, rotY: 0.2, name: 'Caixa de Papelão' });
    placeModel('paper_bag_01', { x: 25, z: -63, floor: true, rotY: -0.5, name: 'Sacola de Papel' });
    placeModel('traffic_cone_01', { x: -146, z: 28, floor: true, name: 'Cone Quarto 1', scale: 1.35 });
    placeModel('traffic_cone_02', { x: -128, z: 4, floor: true, name: 'Cone Quarto 2', scale: 1.35 });
    placeModel('finger_post_sign_01', { x: -128, z: 48, floor: true, rotY: 0.9, isStatic: true, r: 1.2, name: 'Placa: Rampa da Mesa' });
    placeModel('championship_podium', { x: -10, z: 52.6, y: 0, physics: false, name: 'Pódio do Circuito' });

    // Alarme de incêndio e interruptor na parede do fundo
    placeModel('fire_alarm_bell', {
      x: -40, z: -72.9, y: -12, physics: false, name: 'Alarme de Incêndio',
      onLoad: (bell) => { fireBellModel = bell; }
    });
    placeModel('light_switch_01', { x: 30, z: -72.95, y: -16, physics: false, name: 'Interruptor' });
    placeModel('acoustic_guitar', { x: -120, z: -71.2, y: -31, physics: false, name: 'Violão Acústico', occluder: true });
    placeModel('guitar_wall_hanger_02', { x: -120, z: -72.4, y: -8.6, physics: false, name: 'Suporte de Violão' });

    // Postes de luz ao longo do circuito embaixo da mesa (iluminam a pista do chão)
    [[-126, -28], [-48, -45], [62, -38], [-14, 8], [-76, 54]].forEach(([lx, lz], i) => {
      placeModel('lamp_post_01', {
        x: lx, z: lz, floor: true, isStatic: true, r: 1.4, rotY: i * 1.3, name: 'Poste de Luz',
        onLoad: (post) => {
          // Brilho falso (sprite aditivo) no lugar de 5 luzes reais: mesmo efeito visual, custo quase zero
          const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlowTexture, color: 0xffd49a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
          glow.position.set(0, post.userData.dims.h * 0.92, 0);
          glow.scale.setScalar(7);
          post.add(glow);
          nightGlows.push({ mat: glow.material, day: 0.3, night: 0.95 });
          const pool = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ map: softGlowTexture, color: 0xffd49a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
          pool.rotation.x = -Math.PI / 2;
          pool.position.y = 0.08;
          post.add(pool);
          nightGlows.push({ mat: pool.material, day: 0.08, night: 0.45 });
        }
      });
    });
    // Luzes decorativas (postes e preenchimento): desligadas na qualidade Baixa para aliviar aparelhos fracos
    // (cada luz pontual a mais pesa no cálculo de todos os materiais)
    // Luz ambiente suave embaixo do tampo (o circuito do chão fica legível)
    [[0, -18, 0]].forEach(([x, y, z]) => { // uma luz de preenchimento só (antes duas)
      const l = new THREE.PointLight(0xfff3e0, 0.65, 130, 2);
      l.position.set(x, y, z);
      scene.add(l);
      decorLights.push(l);
    });

    // ============================================================================
    // AÇÕES DAS ILHAS
    // ============================================================================
    let audioCtx = null;
    // ============================================================================
    // SONS (Kenney CC0: Impact Sounds, Interface Sounds, Digital Audio) — assets/sfx/*.ogg
    // Cada evento sorteia uma variação e muda levemente o tom; tudo passa por um volume geral
    // (botão Áudio em Opções). Se o navegador não decodificar OGG, o som sintetizado antigo toca no lugar.
    // ============================================================================
    const SFX_GROUPS = {
      hitWall: ['impactSoft_heavy_000', 'impactSoft_heavy_001', 'impactSoft_heavy_002'],
      hitSoft: ['impactSoft_medium_000', 'impactSoft_medium_001', 'impactSoft_medium_002'],
      hitLight: ['impactPlate_light_000', 'impactPlate_light_001', 'impactPlate_light_002'],
      hitWood: ['impactWood_light_000', 'impactWood_light_001', 'impactWood_light_002', 'impactWood_medium_000', 'impactWood_medium_001', 'impactWood_medium_002'],
      hitHeavy: ['impactWood_heavy_000', 'impactWood_heavy_001', 'impactPunch_heavy_000'],
      hitMetal: ['impactMetal_light_000', 'impactMetal_light_001', 'impactMetal_light_002'],
      hitGlass: ['impactGlass_light_000', 'impactGlass_light_001'],
      plank: ['impactPlank_medium_000', 'impactPlank_medium_001', 'impactPlank_medium_002'],
      pin: ['impactWood_medium_000', 'impactWood_medium_001', 'impactWood_medium_002'],
      boom: ['impactPunch_heavy_000', 'impactPunch_heavy_001'],
      boomTail: ['lowDown'],
      explode: ['spaceTrash1', 'spaceTrash2'],
      paper: ['scratch_001', 'scratch_002'],
      powerUp: ['powerUp1', 'powerUp2', 'powerUp3'],
      powerGold: ['zapThreeToneUp'],
      nitro: ['phaserUp1', 'phaserUp2'],
      flip: ['phaseJump1', 'phaseJump2'],
      jump: ['pluck_001', 'pluck_002'],
      countTick: ['tone1'],
      countGo: ['highUp'],
      checkpoint: ['twoTone1'],
      finish: ['threeTone1', 'threeTone2'],
      achievement: ['confirmation_001', 'confirmation_002'],
      reward: ['threeTone2'],
      uiOpen: ['maximize_001', 'open_001'],
      uiClose: ['minimize_001', 'close_001'],
      uiClick: ['click_001', 'click_002', 'click_003'],
      uiMove: ['tick_001', 'select_001', 'select_002'],
      uiToggle: ['toggle_001', 'toggle_002'],
      uiError: ['error_001'],
      grab: ['drop_001'],
      release: ['drop_002'],
      sparkle: ['glass_001', 'bong_001'],
      mud: ['impactSoft_medium_000', 'impactSoft_medium_002'],
      grass: ['footstep_grass_000', 'footstep_grass_001'],
      flap: ['scratch_001', 'scratch_002']
    };
    const sfxState = { buffers: new Map(), loading: false, enabled: true, master: null, voices: 0 };
    try { sfxState.enabled = localStorage.getItem('audioEnabled') !== '0'; } catch (e) { /* sem storage */ }
    function audioOut(ac) {
      if (!sfxState.master) {
        sfxState.master = ac.createGain();
        sfxState.master.gain.value = sfxState.enabled ? 1 : 0;
        sfxState.master.connect(ac.destination);
      }
      return sfxState.master;
    }
    function loadSfx(ac) {
      if (sfxState.loading) return;
      sfxState.loading = true;
      const files = new Set(Object.values(SFX_GROUPS).flat());
      files.forEach((f) => {
        fetch(`./assets/sfx/${f}.ogg`).then((r) => r.arrayBuffer())
          .then((buf) => new Promise((res, rej) => ac.decodeAudioData(buf, res, rej)))
          .then((decoded) => sfxState.buffers.set(f, decoded))
          .catch(() => { /* OGG não suportado: fica o som sintetizado */ });
      });
    }
    // Toca um evento; devolve true se tocou (ou se o som está desligado) — false = use o sintetizador
    function sfx(group, opts = {}) {
      if (!sfxState.enabled) return true;
      const ac = getAudio();
      if (!ac) return false;
      const list = SFX_GROUPS[group];
      if (!list) return false;
      const name = list[Math.floor(Math.random() * list.length)];
      const buf = sfxState.buffers.get(name);
      if (!buf) return false;
      if (sfxState.voices > 24) return true; // limite de vozes simultâneas
      const src = ac.createBufferSource();
      src.buffer = buf;
      const vary = opts.vary !== undefined ? opts.vary : 0.08;
      src.playbackRate.value = (opts.rate || 1) * (1 + (Math.random() * 2 - 1) * vary);
      const g = ac.createGain();
      g.gain.value = opts.vol !== undefined ? opts.vol : 0.6;
      src.connect(g).connect(audioOut(ac));
      sfxState.voices++;
      src.onended = () => { sfxState.voices--; };
      src.start(ac.currentTime + (opts.delay || 0));
      return true;
    }
    function setAudioEnabled(on) {
      sfxState.enabled = on;
      try { localStorage.setItem('audioEnabled', on ? '1' : '0'); } catch (e) { /* sem storage */ }
      if (sfxState.master && audioCtx) sfxState.master.gain.setTargetAtTime(on ? 1 : 0, audioCtx.currentTime, 0.05);
    }
    function getAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      if (audioCtx) loadSfx(audioCtx);
      return audioCtx;
    }
    function playTone(freq, start, dur, type = 'triangle', gain = 0.12) {
      const ac = getAudio();
      if (!ac) return;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ac.currentTime + start);
      g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
      o.connect(g).connect(audioOut(ac));
      o.start(ac.currentTime + start);
      o.stop(ac.currentTime + start + dur + 0.05);
    }
    // Buzina de carrinho de brinquedo: "bi-bi!" — dois toques curtos e anasalados
    // (acorde de duas notas em onda quadrada passando por um filtro, com leve queda de tom no fim)
    function playHonk() {
      const ac = getAudio();
      if (!ac) return;
      const t0 = ac.currentTime;
      [[0, 0.11], [0.17, 0.16]].forEach(([start, dur]) => {
        const out = ac.createGain();
        const filter = ac.createBiquadFilter();
        filter.type = 'bandpass'; filter.frequency.value = 1100; filter.Q.value = 1.6;
        out.gain.setValueAtTime(0.0001, t0 + start);
        out.gain.exponentialRampToValueAtTime(0.16, t0 + start + 0.012);
        out.gain.setValueAtTime(0.16, t0 + start + dur - 0.03);
        out.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        filter.connect(out).connect(audioOut(ac));
        [523.3, 659.3].forEach((f) => {
          const o = ac.createOscillator();
          o.type = 'square';
          o.frequency.setValueAtTime(f, t0 + start);
          o.frequency.linearRampToValueAtTime(f * 0.94, t0 + start + dur);
          o.connect(filter);
          o.start(t0 + start);
          o.stop(t0 + start + dur + 0.02);
        });
      });
    }

    // Sirene de bombeiro: só toca (e só pisca) enquanto o jato d'água está ligado
    let sirenAudio = null;
    function setSirenSound(on) {
      const ac = getAudio();
      if (!ac) return;
      if (on && !sirenAudio) {
        const osc = ac.createOscillator(), lfo = ac.createOscillator(), lfoGain = ac.createGain();
        const filter = ac.createBiquadFilter(), out = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = 820;
        lfo.type = 'triangle';
        lfo.frequency.value = 0.85;  // sobe e desce (uiu-uiu) menos de uma vez por segundo
        lfoGain.gain.value = 230;    // varia de ~590 Hz a ~1050 Hz
        lfo.connect(lfoGain).connect(osc.frequency);
        filter.type = 'lowpass'; filter.frequency.value = 2200;
        out.gain.setValueAtTime(0.0001, ac.currentTime);
        out.gain.exponentialRampToValueAtTime(0.045, ac.currentTime + 0.15);
        osc.connect(filter).connect(out).connect(audioOut(ac));
        osc.start(); lfo.start();
        sirenAudio = { osc, lfo, out };
      } else if (!on && sirenAudio) {
        const { osc, lfo, out } = sirenAudio;
        out.gain.cancelScheduledValues(ac.currentTime);
        out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), ac.currentTime);
        out.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
        osc.stop(ac.currentTime + 0.3); lfo.stop(ac.currentTime + 0.3);
        sirenAudio = null;
      }
    }
    // Aba escondida: sirene nunca fica tocando sozinha
    document.addEventListener('visibilitychange', () => { if (document.hidden) setSirenSound(false); });

    // Notas musicais flutuantes (ícone music-note do DS)
    const musicNoteTexture = new THREE.TextureLoader().load('./assets/ui/music-note.svg');
    const musicNotes = [];
    function spawnMusicNote(x, y, z) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: musicNoteTexture, color: [0xffc67b, 0xffceca, 0xe88eff, 0xd5ff95][musicNotes.length % 4], transparent: true }));
      s.scale.set(1.6, 1.8, 1);
      s.position.set(x, y, z);
      scene.add(s);
      musicNotes.push({ s, t: 0, phase: Math.random() * 6 });
    }

    let rocketLaunch = null;
    const CAMERA_FOV_DEFAULT = 34;
    let rocketCamFovRestore = null; // volta suave ao FOV normal depois da câmera do foguete

    // Evento "Papai, Mamãe e Ravi": câmera vai até o quadro da família na parede do fundo
    const FAMILY_FRAME_POS = new THREE.Vector3(-36, 9.4, -72.6); // centro entre o quadro e a plaquinha
    let familyView = null;
    function startFamilyFrameView() {
      familyView = { t: 0, look: camera.position.clone().lerp(FAMILY_FRAME_POS, 0.5) };
      notify({ type: 'success', title: 'Papai, Mamãe e Ravi ❤', description: 'Acelere para voltar a dirigir', duration: 6000 });
      showCarSpeech('Minha família! ❤', 3000);
      playTone(523.3, 0, 0.25, 'triangle', 0.08); playTone(659.3, 0.22, 0.25, 'triangle', 0.08); playTone(784, 0.44, 0.5, 'triangle', 0.08);
      progressAchievement('islandActions', 1);
    }
    const jumpingFish = [];
    function spawnJumpingFish() {
      for (let i = 0; i < 4; i++) {
        const fish = new THREE.Group();
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), new THREE.MeshStandardMaterial({ color: [0xff8f3d, 0xffc300, 0xff6a7c, 0x5fc8ff][i], roughness: 0.4 }));
        body.scale.set(1.5, 0.8, 0.6);
        const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.9, 4), body.material);
        tail.rotation.z = Math.PI / 2;
        tail.position.x = -1.3;
        fish.add(body, tail);
        scene.add(fish);
        const a = Math.random() * Math.PI * 2;
        jumpingFish.push({
          fish, t: -i * 0.35, dur: 1.2,
          x0: LAKE.x + Math.cos(a) * 9, z0: LAKE.z + Math.sin(a) * 7,
          x1: LAKE.x + Math.cos(a + 0.9) * 13, z1: LAKE.z + Math.sin(a + 0.9) * 10
        });
      }
    }

    // Músicas da Ilha da Música: melodias tocadas em notas (frequência Hz, duração em tempos)
    const SONG_NOTE_HZ = { C4: 261.6, D4: 293.7, E4: 329.6, F4: 349.2, G4: 392, A4: 440, B4: 493.9, C5: 523.3, D5: 587.3, E5: 659.3 };
    const ISLAND_SONGS = {
      estrelinha: {
        title: 'Brilha, brilha estrelinha', speech: '🎵 brilha, brilha...', beat: 0.32,
        notes: [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2],
                ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2]]
      },
      // Ritmo das sílabas da cantiga (8 + 8 + 6 + 6 + 4 + 4); "tibum" sobe e o "chuá" desce, como um mergulho
      baleia: {
        title: 'A baleia é amiga da sereia', speech: '🐋 tibum, chuá!', beat: 0.21,
        notes: [
          // frase 1 (duas vezes, a segunda um tom acima)
          ['G4', 1], ['C5', 1], ['C5', 1], ['C5', 2], ['G4', 1], ['D5', 1], ['D5', 1], ['D5', 2],
          // frase 2
          ['E5', 1], ['D5', 1], ['C5', 1], ['D5', 1], ['E5', 1], ['E5', 1], ['D5', 1], ['C5', 2],
          // frase 3 (duas vezes)
          ['C5', 1], ['A4', 1], ['C5', 1], ['A4', 1], ['G4', 1], ['E4', 2],
          ['C5', 1], ['A4', 1], ['C5', 1], ['A4', 1], ['G4', 1], ['G4', 2],
          // tibum, chuá (duas vezes)
          ['G4', 1], ['C5', 1], ['E5', 1], ['C5', 2],
          ['G4', 1], ['C5', 1], ['G4', 1], ['C5', 3]
        ]
      },
      lobato: {
        title: 'Ia ia ô (Seu Lobato tinha um sítio)', speech: '🐮 ia ia ô!', beat: 0.28,
        notes: [['G4', 1], ['G4', 1], ['G4', 1], ['D4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
                ['B4', 1], ['B4', 1], ['A4', 1], ['A4', 1], ['G4', 3], ['D4', 1],
                ['G4', 1], ['G4', 1], ['G4', 1], ['D4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
                ['B4', 1], ['B4', 1], ['A4', 1], ['A4', 1], ['G4', 3]]
      }
    };
    let islandSongTimers = [];
    function playIslandSong(id) {
      const song = ISLAND_SONGS[id];
      if (!song) return;
      // Troca de música: para a anterior antes de começar a nova
      islandSongTimers.forEach(clearTimeout);
      islandSongTimers = [];
      let t = 0;
      song.notes.forEach(([note, beats]) => {
        const dur = beats * song.beat;
        playTone(SONG_NOTE_HZ[note], t, Math.max(0.12, dur * 0.92), 'triangle', 0.14);
        islandSongTimers.push(setTimeout(() => spawnMusicNote(104 + (Math.random() - 0.5) * 8, ISLAND_Y + 5, -46 + (Math.random() - 0.5) * 8), t * 1000));
        t += dur;
      });
      notify({ type: 'music', title: song.title, description: 'Tocando agora na Ilha da Música', duration: Math.max(4000, t * 1000) });
      showCarSpeech(song.speech, 2600);
      progressAchievement('islandActions', 1);
    }

    function performIslandAction(isl) {
      if (isl.id === 'fire') {
        waterLevel = 100;
        if (holdingPistol()) pistolWater = PISTOL_CAP; // o posto enche também a pistola d'água
        updateWaterHUD();
        fillBatteryTo100();
        splashAt(-118, ISLAND_Y + 4, 76, 30, 1.6);
        showCarSpeech('Tanque cheio! Pronto pra missão!', 2600);
        notify({ type: 'success', title: 'Tanque cheio!', description: 'O caminhãozinho está pronto para apagar incêndios.' });
      } else if (isl.id === 'space') {
        if (!spaceRocket || rocketLaunch) return;
        rocketLaunch = { t: 0, baseY: spaceRocket.position.y };
        showCarSpeech('3, 2, 1... decolar!', 2600);
        notify({ type: 'music', title: 'Decolagem!', description: 'O foguete do Ravi foi visitar a Lua' });
      } else if (isl.id === 'music') {
        playIslandSong('estrelinha');
        return;
      } else if (isl.id === 'toys') {
        confettiBurst(-52, ISLAND_Y + 3, 79, 90);
        playTone(523, 0, 0.12); playTone(659, 0.12, 0.12); playTone(784, 0.24, 0.2);
        showCarSpeech('Hora de brincar!', 2400);
      } else if (isl.id === 'lake') {
        spawnJumpingFish();
        showCarSpeech('Oi, peixinhos!', 2400);
      }
      progressAchievement('islandActions', 1);
    }

    // Plantas em vaso balançam como mola: brisa, ar do carrinho passando e batidas no vaso
    function updatePlantWobble(dt) {
      const cp = vehicle.position, sp = Math.abs(carSpeed);
      const k = Math.min(dt, 0.05);
      growablePlants.forEach((p) => {
        const targets = p.foliageGroup ? [p.foliageGroup] : (p.foliageMeshes || []);
        if (!targets.length) return;
        const w = p.wob || (p.wob = { ax: 0, az: 0, vx: 0, vz: 0 });
        const big = !p.foliageGroup; // yucca do quarto: balança menos
        let tx = windState.z * windState.strength * (big ? 0.015 : 0.05), tz = -windState.x * windState.strength * (big ? 0.015 : 0.05);
        const px = p.x, pz = p.z;
        const sameLevel = (p.onFloor ? 'floor' : 'desk') === levelOfY(cp.y);
        const dx = px - cp.x, dz = pz - cp.z, d = Math.hypot(dx, dz);
        if (sameLevel && d < 8 && d > 0.01) {
          const push = (1 - d / 8) * Math.min(1, sp * 4) * (big ? 0.12 : 0.45);
          tx += (dz / d) * push; tz += -(dx / d) * push;
        }
        if (p.obs && p.obs._dyn) { tx += p.obs.vz * 2.5; tz += -p.obs.vx * 2.5; } // vaso empurrado: folhas chicoteiam
        w.vx += ((tx - w.ax) * 38 - w.vx * 3.2) * k;
        w.vz += ((tz - w.az) * 38 - w.vz * 3.2) * k;
        w.ax += w.vx * k; w.az += w.vz * k;
        targets.forEach((t) => { t.rotation.x = w.ax; t.rotation.z = w.az; });
      });
    }

    // Anima os efeitos do mundo a cada quadro
    function updateWorldEffects(time, dt) {
      updatePlantWobble(dt);
      sweepTempPaint(time);
      worldUniforms.uTime.value = time;
      worldUniforms.uPlayer.value.copy(vehicle.position);
      {
        const pv = worldUniforms.uPlayerVel.value, k = Math.min(1, dt * 6);
        pv.x += (Math.sin(carAngle) * carSpeed * 3 - pv.x) * k;
        pv.z += (Math.cos(carAngle) * carSpeed * 3 - pv.z) * k;
      }
      updateWind(time, dt);
      updateDebris(time, dt);
      updateCampfire(time, dt);
      updateBajaCharger(time);
      updateCoins(time);
      updateKenneyToys(time);
      updateDoors();
      updateRallyFx(time, dt);
      rallyFlags.forEach((f, i) => { f.rotation.x = Math.sin(time * 6 + i) * 0.12 * windState.strength; });
      updateFallingLeaves(time, dt);
      wallClock.update();
      // Líquidos: tempo dos shaders, vapor do café e água do copo agitada pelo carrinho passando perto
      liquidUniforms.uTime.value = time;
      updateCoffeeSteam(dt, time);
      {
        const tp = tumblerGroup.position;
        const near = Math.hypot(vehicle.position.x - tp.x, vehicle.position.z - tp.z);
        const target = vehicle.position.y > -15 ? clamp((1 - near / 12) * (0.4 + Math.abs(carSpeed) * 2), 0, 1) : 0;
        cupWaterMat.uniforms.uAgitation.value += (target - cupWaterMat.uniforms.uAgitation.value) * Math.min(1, dt * 3);
      }
      updateCareerObjects(time);
      updateBowlingGame(time, dt);
      updateExplosionFx(dt);
      updateBatteryRespawns(time);
      updateFx(dt);
      updateRevealRings(dt);

      islands.forEach((isl, i) => {
        isl.pointMeshes.diamond.rotation.y = time * 1.4 + i;
        isl.pointMeshes.diamond.position.y = ISLAND_Y + 3 + Math.sin(time * 2 + i) * 0.35;
        isl.pointMeshes.ring.material.opacity = 0.55 + Math.sin(time * 3 + i) * 0.3;
      });

      if (lakeBoat) {
        lakeBoat.position.y = FLOOR_SURFACE_Y + 0.05 + Math.sin(time * 1.5) * 0.12;
        lakeBoat.rotation.z = Math.sin(time * 1.1) * 0.05;
        lakeBoat.rotation.x = Math.sin(time * 0.9 + 1) * 0.04;
      }

      if (rocketLaunch && spaceRocket) {
        rocketLaunch.t += dt;
        const t = rocketLaunch.t;
        let y = rocketLaunch.baseY;
        const rx = spaceRocket.position.x, rz = spaceRocket.position.z;
        const flame = (vy, n) => {
          for (let i = 0; i < n; i++) spawnFx(rx + (Math.random() - 0.5) * 1.2, y + 0.2, rz + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 3, vy - Math.random() * 4, (Math.random() - 0.5) * 3, Math.random() > 0.5 ? 0xffc300 : 0xff6a3d, 0.7, -2, 0.8);
        };
        // Roteiro: ignição (0–1.4) → subida (1.4–4.6) → lá no alto (4.6–5.4) → descida com retrofoguete (5.4–7.8) → pouso
        if (t < 1.4) {
          spaceRocket.rotation.z = Math.sin(t * 60) * 0.03 * (t / 1.4);
          if (t > 0.6) flame(-3, 2);
        } else if (t < 4.6) {
          const k = (t - 1.4) / 3.2;
          y += k * k * 75;
          spaceRocket.rotation.z = 0;
          flame(-6, 3);
        } else if (t < 5.4) {
          y += 75 + Math.sin((t - 4.6) * 4) * 0.6;
          spaceRocket.rotation.y += dt * 1.5;
        } else if (t < 7.8) {
          const k = (t - 5.4) / 2.4;
          y += 75 * Math.pow(1 - k, 2); // desacelera ao se aproximar do chão
          spaceRocket.rotation.y += dt * 2 * (1 - k);
          if (k > 0.45) flame(-4, 2);
        } else {
          rocketLaunch = null;
          rocketCamFovRestore = CAMERA_FOV_DEFAULT;
          islands.forEach((isl) => { if (isl.label) isl.label.visible = true; });
          spaceRocket.rotation.set(0, 0, 0);
          confettiBurst(rx, y + 2, rz, 30);
        }
        spaceRocket.position.y = y;
      }

      for (let i = musicNotes.length - 1; i >= 0; i--) {
        const n = musicNotes[i];
        n.t += dt;
        n.s.position.y += dt * 4;
        n.s.position.x += Math.sin(time * 3 + n.phase) * dt * 2;
        n.s.material.opacity = Math.max(0, 1 - n.t / 3);
        if (n.t > 3) { scene.remove(n.s); musicNotes.splice(i, 1); }
      }

      for (let i = jumpingFish.length - 1; i >= 0; i--) {
        const f = jumpingFish[i];
        f.t += dt;
        const k = f.t / f.dur;
        if (k < 0) { f.fish.visible = false; continue; }
        f.fish.visible = true;
        const x = THREE.MathUtils.lerp(f.x0, f.x1, k), z = THREE.MathUtils.lerp(f.z0, f.z1, k);
        f.fish.position.set(x, FLOOR_SURFACE_Y + Math.sin(Math.PI * Math.min(1, k)) * 7, z);
        f.fish.rotation.y = -Math.atan2(f.z1 - f.z0, f.x1 - f.x0);
        f.fish.rotation.z = Math.cos(Math.PI * Math.min(1, k)) * 0.9;
        if (k >= 1) {
          splashAt(x, FLOOR_SURFACE_Y + 0.3, z, 12);
          scene.remove(f.fish);
          jumpingFish.splice(i, 1);
        }
      }

      // Bolas rolam visualmente ao serem empurradas
      dynamicObstacles.forEach((o) => {
        if (!o.group || !o.group.userData.rolls) return;
        // Rola pela distância realmente percorrida (sem escorregar, em qualquer taxa de quadros)
        const last = o._rollLast || (o._rollLast = { x: o.x, z: o.z });
        const mx = o.x - last.x, mz = o.z - last.z;
        last.x = o.x; last.z = o.z;
        const dist = Math.hypot(mx, mz);
        if (dist < 1e-4 || dist > 20) return;
        const inner = o.group.children[0];
        const axis = new THREE.Vector3(mz, 0, -mx).normalize();
        inner.rotateOnWorldAxis(axis, dist / Math.max(0.5, o.r));
      });
    }


    // Objetos fixos grandes da mesa e do quarto que podem tapar a visão do carrinho
    [monitorGroup, radioGroup, laptopGroup, dualArmGroup, fireStation, aquariumGroup]
      .forEach(registerOccluderTree);

    // Modelos arredondados usam colisor circular; todos os demais usam caixa orientada (OBB)
    ['traffic_cone_01', 'traffic_cone_02', 'apple', 'cheeseburger', 'rocket_toy_01', 'rocket_toy_02', 'desk_lamp', 'mesh_bin',
      'flower_pot_01', 'mushroom_01', 'mushroom_02', 'mushroom_03', 'globe', 'volleyball', 'crystal', 'mug', 'office_chair',
      'japanese_stone_lantern_01', 'lamp_post_01', 'pacifier_01', 'rock_01', 'rock_02'
    ].forEach((k) => { if (MODEL_LIBRARY[k]) MODEL_LIBRARY[k].collider = 'circle'; });

    // ============================================================================
    // MAIS FOLHAGEM PELO QUARTO (arbustos com shader de vento + tufos de grama)
    // ============================================================================
    function createBush(x, z, y, scale = 1, variant = 0) {
      if ((x >= QUINTAL_MIN_X) !== IS_QUINTAL) { obstacles.push({ x, z, r: 0, h: 0, name: 'ARBUSTO (outro cenário)', isStatic: true, level: 'floor' }); return; }
      const R = 2.6 * scale, count = Math.round(150 * scale);
      const pos = [], uv = [], centers = [], shade = [], heights = [], idx = [];
      const right = new THREE.Vector3(), up = new THREE.Vector3(), nrm = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random()); // meia esfera
        const rr = R * Math.cbrt(0.3 + Math.random() * 0.7);
        const c = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * rr * 1.25, Math.cos(ph) * rr * 0.8 + 0.4, Math.sin(ph) * Math.sin(th) * rr * 1.25);
        nrm.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        right.set(0, 1, 0).cross(nrm).normalize();
        if (right.lengthSq() < 0.01) right.set(1, 0, 0);
        up.crossVectors(nrm, right).normalize();
        const s = 0.75 * scale, base = pos.length / 3;
        [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([a, b, uu, vv]) => {
          pos.push(x + c.x + (right.x * a + up.x * b) * s, y + c.y + (right.y * a + up.y * b) * s, z + c.z + (right.z * a + up.z * b) * s);
          uv.push(uu, vv);
          centers.push(x + c.x, y + c.y, z + c.z);
          shade.push(THREE.MathUtils.clamp(c.y / (R * 0.9), 0, 1));
          heights.push(THREE.MathUtils.clamp(c.y / (R * 1.2), 0.15, 1) * 0.8);
        });
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
      g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
      g.setAttribute('aHeight', new THREE.Float32BufferAttribute(heights, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      g.boundingSphere.radius += 2;
      scene.add(new THREE.Mesh(g, foliageMaterials[variant % foliageMaterials.length]));
      treeCrowns.push({ x, z, y: y + R * 0.6, r: R, groundY: y, variant });
      obstacles.push({ x, z, r: R * 0.9, h: R * 0.9, name: 'ARBUSTO', isStatic: true, level: levelOfY(y) });
    }
    function scatterGrass(cx, cz, radius, count, y = FLOOR_SURFACE_Y) {
      const pts = [];
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * radius;
        pts.push({ x: cx + Math.cos(a) * rr, y, z: cz + Math.sin(a) * rr, h: 0.45 + Math.random() * 0.8 });
      }
      createGrassPatch(pts);
    }
    [
      [-10, -64, 1.1, 0], [12, -66, 0.9, 2], [-78, -63, 1.0, 1], [88, -66, 0.9, 0],
      [-162, 64, 1.0, 0], [-162, 88, 1.1, 2], [-72, 89, 0.9, 0], [0, 89, 1.0, 1],
      [30, 89, 0.8, 2], [98, 90, 0.9, 0], [118, 50, 1.0, 1], [-60, 8, 0.9, 0],
      [78, 12, 0.9, 2], [-150, -70, 0.9, 1]
    ].forEach(([x, z, s, v]) => {
      createBush(x, z, FLOOR_SURFACE_Y, s, v);
      scatterGrass(x, z, 4.2 * s, Math.round(220 * s));
    });
    // Gramados maiores (o chão vira o terreno do mundo do DS: lajotas, grama e água)
    [[-25, -8, 13], [26, -2, 9], [-86, 80, 7], [-118, 4, 8], [86, 48, 5]].forEach(([x, z, r]) => scatterGrass(x, z, r, Math.round(r * r * 13)));

    // Colunas de pedra hexagonais lilás (como as rochas basálticas do mundo do DS)
    const basaltMat = new THREE.MeshStandardMaterial({ color: 0x8f7fe0, roughness: 0.75, flatShading: true });
    const basaltTopMat = new THREE.MeshStandardMaterial({ color: 0xb6abf5, roughness: 0.6, flatShading: true });
    function createBasaltCluster(cx, cz, count = 5) {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.6, d = i === 0 ? 0 : 2.4 + Math.random() * 1.2;
        const r = 1.4 + Math.random() * 0.8, h = 3 + Math.random() * 7 * (i === 0 ? 1.3 : 1);
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const col = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), [basaltMat, basaltTopMat, basaltMat]);
        col.position.set(x, FLOOR_SURFACE_Y + h / 2, z);
        col.rotation.y = Math.random();
        col.castShadow = true; col.receiveShadow = true;
        scene.add(col);
        registerOccluderTree(col);
        obstacles.push({ x, z, r: r * 0.95, h, name: 'COLUNA DE PEDRA', isStatic: true, level: 'floor' });
      }
    }
    createBasaltCluster(53, 86, 4);
    createBasaltCluster(-122, -67, 5);
    createBasaltCluster(-163, -52, 4);

    // Tufos soltos ao longo das paredes e perto das colunas da mesa
    [[-40, -68, 5], [40, -68, 4], [-130, -68, 4], [-165, 10, 3], [-120, 91, 3], [60, 91, 3], [120, -10, 3], [-68, 26, 3], [68, -26, 3]]
      .forEach(([x, z, r]) => scatterGrass(x, z, r, Math.round(r * r * 14)));

    // ============================================================================
    // OBJETOS DO MUNDO DO DS: CAIXAS-SURPRESA, MUROS DE TIJOLINHOS, CONES E BOLICHE
    // ============================================================================
    const surpriseCrates = [];
    const crateTexture = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c0392b'; ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#e74c3c';
      for (let i = 0; i < 4; i++) ctx.fillRect(6, 6 + i * 30, 116, 24);
      ctx.strokeStyle = '#7b1e16'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 120, 120);
      ctx.beginPath(); ctx.moveTo(8, 8); ctx.lineTo(120, 120); ctx.stroke();
      ctx.fillStyle = '#ffd166'; ctx.font = '900 56px Nunito, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', 64, 68);
      const t = new THREE.CanvasTexture(c);
      t.encoding = THREE.sRGBEncoding;
      return t;
    })();
    const crateMaterial = new THREE.MeshStandardMaterial({ map: crateTexture, roughness: 0.7 });
    function createSurpriseCrate(x, z, y, size = 3) {
      const group = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), crateMaterial);
      box.position.y = size / 2;
      box.castShadow = true; box.receiveShadow = true;
      group.add(box);
      group.position.set(x, y, z);
      group.rotation.y = Math.random() * Math.PI;
      group.name = 'Caixa-Surpresa';
      scene.add(group);
      const obs = registerDynamicObstacle({ obs: { x, z, r: size * 0.62, box: { hx: size / 2, hz: size / 2 }, h: size, name: 'CAIXA-SURPRESA' }, group, mass: 1.3, canTopple: true });
      obs.crate = true;
      surpriseCrates.push(obs);
      return obs;
    }
    // Explosão de confete que empurra tudo em volta (como as caixas explosivas do mundo do Bruno)
    function explodeCrate(obs) {
      if (obs.exploded) return;
      obs.exploded = true;
      obs.group.visible = false;
      obs.savedR = obs.r;
      obs.r = 0.001;
      const p = obs.group.position;
      confettiBurst(p.x, p.y + 1.5, p.z, 80);
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        spawnFx(p.x, p.y + 1.5, p.z, Math.cos(a) * 9, 8 + Math.random() * 6, Math.sin(a) * 9, 0xc0392b, 1.4, 20, 1.8);
      }
      if (!(sfx('explode', { vol: 0.6 }) && sfx('plank', { vol: 0.6, delay: 0.04 }))) { playTone(140, 0, 0.35, 'sawtooth', 0.09);
      playTone(90, 0.05, 0.4, 'square', 0.07); }
      rumble(0.8, 1, 260);
      dynamicObstacles.forEach((o) => {
        if (o === obs || o.level !== obs.level) return;
        const dx = o.x - obs.x, dz = o.z - obs.z, d = Math.hypot(dx, dz);
        if (d > 11 || d < 1e-3) return;
        const f = (1 - d / 11) * 1.1 / (o.mass || 1);
        o.vx += (dx / d) * f; o.vz += (dz / d) * f;
        if (o.ball) o.hopV = Math.max(o.hopV || 0, 0.35 * (1 - d / 11));
        if (o.pin) knockPin(o, dx / d, dz / d);
      });
      const v = vehicle.position, dv = Math.hypot(v.x - obs.x, v.z - obs.z);
      if (dv < 9 && Math.abs(v.y - p.y) < 4 && !carAirborne) launchVehicle(0.3 * (1 - dv / 9) + 0.12);
      showCarSpeech('BUM! Surpresa!', 1800);
      logInteractionEvent('🎁 Caixa-surpresa explodiu em confete!');
      progressAchievement('crates', 1);
    }
    [[-160, -30], [-118, -48], [30, -50], [66, -30], [-60, 44], [-160, 20]].forEach(([x, z]) => createSurpriseCrate(x, z, FLOOR_SURFACE_Y));
    [[-84, 30], [80, -30], [-30, 52]].forEach(([x, z]) => createSurpriseCrate(x, z, 0, 2.4));

    // Muros de tijolinhos (cada tijolo é um objeto que cai e desliza)
    const brickMat = new THREE.MeshStandardMaterial({ color: 0xb5523b, roughness: 0.85 });
    // Tijolos maiores (proporção do carrinho: ~2.6 de largura)
    const BRICK = { w: 2.7, h: 1.35, d: 1.35 };
    const brickGeo = new THREE.BoxGeometry(BRICK.w, BRICK.h, BRICK.d);
    function createBrickWall(x, z, y, rotY, cols = 4, rows = 3) {
      const dirX = Math.cos(rotY), dirZ = -Math.sin(rotY);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const off = (c - (cols - 1) / 2) * (BRICK.w + 0.06) + (r % 2 ? BRICK.w / 2 : 0);
          const bx = x + dirX * off, bz = z + dirZ * off;
          const group = new THREE.Group();
          const brick = new THREE.Mesh(brickGeo, brickMat);
          brick.position.y = BRICK.h / 2;
          brick.castShadow = true; brick.receiveShadow = true;
          group.add(brick);
          group.position.set(bx, y + r * (BRICK.h + 0.02), bz);
          group.rotation.y = rotY;
          scene.add(group);
          const obs = registerDynamicObstacle({ obs: { x: bx, z: bz, r: 1.1, box: { hx: BRICK.w / 2, hz: BRICK.d / 2 }, h: BRICK.h, name: 'TIJOLINHO' }, group, mass: 0.75, canTopple: true });
          obs.friction = 0.86; // tijolo arrasta no chão e para logo
          obs.stackOffset = r * (BRICK.h + 0.02);     // tijolos de cima caem quando o muro é atingido
          obs.initStack = obs.stackOffset;
          obs.restOffset = (y - surfaceBaseY(y));
          obs.brickWall = { x, z };
        }
      }
    }
    createBrickWall(-100, -24, FLOOR_SURFACE_Y, 0.2);
    createBrickWall(22, 42, FLOOR_SURFACE_Y, -0.3, 5, 3);
    createBrickWall(52, 52.2, 0, 0, 3, 2);

    // Cones marcando os ápices das chicanes (mesa e chão)
    [[-40, 51.5], [-20, 51.8], [0, 51.5], [20, 51.8], [74, 22], [74, -20]].forEach(([x, z], i) => {
      placeModel(i % 2 ? 'traffic_cone_02' : 'traffic_cone_01', { x, z, scale: 0.75, name: 'Cone da Pista' });
    });
    [[18, 18.5], [0, 39.5], [-18, 18.5], [-36, 39.5], [-54, 20.5], [-150, -42], [68, -13]].forEach(([x, z], i) => {
      placeModel(i % 2 ? 'traffic_cone_02' : 'traffic_cone_01', { x, z, floor: true, name: 'Cone da Pista' });
    });

    // ---------- Boliche (bola pesada que rola e pinos que tombam) ----------
    const BOWLING = { x: 42, zStart: 58, zEnd: 92, pinsZ: 80 };
    (function createBowlingLane() {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 512;
      const ctx = c.getContext('2d');
      for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#d9a066' : '#e3ad74'; ctx.fillRect(i * 16, 0, 16, 512); }
      ctx.fillStyle = '#5b3a1e'; ctx.fillRect(0, 0, 10, 512); ctx.fillRect(118, 0, 10, 512);
      ctx.fillStyle = '#c21515';
      [[40, 330], [64, 310], [88, 330]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 7, y + 18); ctx.lineTo(x + 7, y + 18); ctx.fill(); });
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      const lane = new THREE.Mesh(
        new THREE.PlaneGeometry(12, BOWLING.zEnd - BOWLING.zStart),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      lane.rotation.x = -Math.PI / 2;
      lane.position.set(BOWLING.x, FLOOR_SURFACE_Y + 0.04, (BOWLING.zStart + BOWLING.zEnd) / 2);
      lane.receiveShadow = true;
      scene.add(lane);
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: createDsLabelTexture('Boliche', { width: 512, height: 128 }), depthWrite: false }));
      sign.scale.set(9, 2.25, 1);
      sign.position.set(BOWLING.x, FLOOR_SURFACE_Y + 14.6, BOWLING.zEnd - 1.2);
      scene.add(sign);
    })();

    const bowlingPins = [];
    const pinGeometry = (() => {
      const pts = [[0, 0], [0.55, 0], [0.72, 0.6], [0.78, 1.4], [0.6, 2.4], [0.36, 3.1], [0.42, 3.7], [0.36, 4.2], [0.12, 4.45], [0, 4.5]]
        .map(([r, y]) => new THREE.Vector2(r, y));
      return new THREE.LatheGeometry(pts, 16);
    })();
    const pinMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const pinStripeMaterial = new THREE.MeshStandardMaterial({ color: 0xc21515, roughness: 0.3 });
    function createBowlingPin(x, z) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(pinGeometry, pinMaterial);
      body.castShadow = true;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 16), pinStripeMaterial);
      stripe.position.y = 3.35;
      group.add(body, stripe);
      group.position.set(x, FLOOR_SURFACE_Y, z);
      scene.add(group);
      const obs = registerDynamicObstacle({ obs: { x, z, r: 0.72, h: 4.5, name: 'PINO DE BOLICHE' }, group, mass: 0.35, canTopple: false });
      obs.pin = true;
      obs.knockT = 0;
      bowlingPins.push(obs);
    }
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i <= row; i++) createBowlingPin(BOWLING.x + (i - row / 2) * 2.1, BOWLING.pinsZ + row * 1.9);
    }
    let bowlingCheckTimer = null;
    function knockPin(obs, dx, dz) {
      if (!obs.pin || obs.knocked) return;
      const len = Math.hypot(dx, dz) || 1;
      obs.knocked = true;
      obs.knockT = 0;
      obs.knockAxis = new THREE.Vector3(dz / len, 0, -dx / len);
      obs.r = 0.6;
      if (!sfx('pin', { vol: 0.55, rate: 1.2 })) { playTone(300 + Math.random() * 200, 0, 0.08, 'square', 0.05); }
      clearTimeout(bowlingCheckTimer);
      if (bowlingGame.active) return; // durante o evento o placar conta os pontos
      bowlingCheckTimer = setTimeout(() => {
        const down = bowlingPins.filter(p => p.knocked).length;
        if (down === bowlingPins.length) {
          notify({ type: 'achievement', title: 'STRIKE!', description: 'Todos os 10 pinos derrubados!', progress: '10 / 10', duration: 5000 });
          confettiBurst(BOWLING.x, FLOOR_SURFACE_Y + 3, BOWLING.pinsZ + 3, 90);
          unlockAchievement('bowling');
        } else if (down > 0) {
          notify({ type: 'info', title: `${down} pino${down > 1 ? 's' : ''} derrubado${down > 1 ? 's' : ''}!`, description: 'Arrume os pinos no ponto do boliche', duration: 3000 });
        }
      }, 2200);
    }
    // Bola de boliche (pesada, rola longe e quica)
    const bowlingBall = (() => {
      const group = new THREE.Group();
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1.5, 32, 24),
        new THREE.MeshStandardMaterial({ color: 0x5b2a86, roughness: 0.18, metalness: 0.1, envMap: envMapTexture, envMapIntensity: 0.8 })
      );
      ball.position.y = 1.5;
      ball.castShadow = true;
      const holeMat = new THREE.MeshBasicMaterial({ color: 0x14081f });
      [[0, 0.2], [-0.35, -0.18], [0.35, -0.18]].forEach(([a, b]) => {
        const hole = new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), holeMat);
        const n = new THREE.Vector3(a, 0.85 + b, 0.5).normalize();
        hole.position.copy(n.clone().multiplyScalar(1.505));
        hole.lookAt(n.clone().multiplyScalar(3));
        ball.add(hole);
      });
      group.add(ball);
      group.position.set(BOWLING.x, FLOOR_SURFACE_Y, BOWLING.zStart + 5);
      group.userData.rolls = true;
      scene.add(group);
      const obs = registerDynamicObstacle({ obs: { x: BOWLING.x, z: BOWLING.zStart + 5, r: 1.5, h: 3, name: 'BOLA DE BOLICHE' }, group, mass: 1.3, canTopple: false });
      // Bola de boliche: pesada (quase a massa do carrinho), pouco elástica, rola longe e quase não quica
      obs.ball = true;
      obs.mass = 1.5; obs.restitution = 0.22; obs.friction = 0.994; obs.bounce = 0.2; obs.wallE = 0.35; obs.lift = 0.04;
      return obs;
    })();
    function resetBowling() {
      bowlingPins.forEach((p) => {
        p.knocked = false; p.knockT = 0; p.r = 0.72;
        p.vx = p.vz = p.vRotY = 0;
        p.x = p.initX; p.z = p.initZ;
        p.group.position.set(p.initX, FLOOR_SURFACE_Y, p.initZ);
        p.group.rotation.set(0, 0, 0);
        p.group.quaternion.identity();
        p.level = 'floor';
      });
      const b = bowlingBall;
      b.vx = b.vz = 0; b.hop = 0; b.hopV = 0;
      b.x = b.initX; b.z = b.initZ;
      b.group.position.set(b.initX, FLOOR_SURFACE_Y, b.initZ);
      b.level = 'floor';
    }
    const bowlingInteractive = {
      id: 'bowling', name: 'Boliche', point: [BOWLING.x - 8, BOWLING.zStart + 3], y: FLOOR_SURFACE_Y,
      text: 'Ilha do Boliche: empurre a bola com o carrinho e derrube os 10 pinos! A cada jogada os pinos são arrumados e o carrinho volta para a frente da bola. Sair da área do boliche encerra o jogo.',
      actions: [
        { label: '🎳 Jogar boliche', run: () => startBowlingGame() },
        { label: 'Arrumar os pinos', run: () => { resetBowling(); showCarSpeech('Pinos arrumados!', 1600); } }
      ]
    };

    // ---------- Evento do Boliche: LEDs na pista, placar e rodadas automáticas ----------
    const BOWLING_AREA = { x0: BOWLING.x - 13, x1: BOWLING.x + 13, z0: BOWLING.zStart - 10, z1: BOWLING.zEnd };
    const BOWLING_BEST_KEY = 'fire_engine_bowling_best_v1';
    let bowlingBest = 0;
    try { bowlingBest = parseInt(localStorage.getItem(BOWLING_BEST_KEY) || '0', 10) || 0; } catch (e) { /* ignora */ }
    const bowlingGame = { active: false, phase: 'idle', t: 0, throwNo: 0, total: 0, strikes: 0, last: null, lastText: '' };

    // Fileiras de LEDs nas duas canaletas (InstancedMesh com cor por LED)
    const BOWLING_LEDS_PER_SIDE = 18;
    const bowlingLeds = (() => {
      const geo = new THREE.BoxGeometry(0.45, 0.22, 0.9);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mesh = new THREE.InstancedMesh(geo, mat, BOWLING_LEDS_PER_SIDE * 2);
      const m4 = new THREE.Matrix4();
      const len = BOWLING.zEnd - BOWLING.zStart - 2;
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < BOWLING_LEDS_PER_SIDE; i++) {
          const z = BOWLING.zStart + 1 + (i / (BOWLING_LEDS_PER_SIDE - 1)) * len;
          m4.makeTranslation(BOWLING.x + (s ? 6.35 : -6.35), FLOOR_SURFACE_Y + 0.12, z);
          mesh.setMatrixAt(s * BOWLING_LEDS_PER_SIDE + i, m4);
          mesh.setColorAt(s * BOWLING_LEDS_PER_SIDE + i, new THREE.Color(0x35e0ff));
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      return mesh;
    })();
    // Visual de "ilha" do boliche: duas faixas de gramado (mesma terra/grama das ilhas) ladeando a pista,
    // com a frente aberta como entrada. Baixinhas (0,12) para o carrinho passar sem tropeçar.
    (function bowlingIslandBanks() {
      const H = 0.12;
      [[BOWLING.x - 10.6, 7.2], [BOWLING.x + 10.6, 7.2]].forEach(([cx, w]) => {
        const z0 = BOWLING.zStart - 6, z1 = BOWLING.zEnd - 0.5, len = z1 - z0, r = 2.2;
        const s = new THREE.Shape();
        const hx = w / 2, hz = len / 2;
        s.moveTo(-hx + r, -hz); s.lineTo(hx - r, -hz); s.quadraticCurveTo(hx, -hz, hx, -hz + r);
        s.lineTo(hx, hz - r); s.quadraticCurveTo(hx, hz, hx - r, hz); s.lineTo(-hx + r, hz);
        s.quadraticCurveTo(-hx, hz, -hx, hz - r); s.lineTo(-hx, -hz + r); s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
        const geo = new THREE.ExtrudeGeometry(s, { depth: H, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        // Extrusão: grupo 0 = topo/base (grama), grupo 1 = laterais (terra)
        const bank = new THREE.Mesh(geo, [islandGroundMat[1], islandGroundMat[0]]);
        bank.position.set(cx, FLOOR_SURFACE_Y, (z0 + z1) / 2);
        bank.receiveShadow = true;
        bedroomWorld.add(bank);
        const pts = [];
        for (let i = 0; i < Math.round(w * len * 2.6); i++) {
          pts.push({ x: cx + (Math.random() - 0.5) * (w - 0.8), y: FLOOR_SURFACE_Y + H, z: z0 + 0.4 + Math.random() * (len - 0.8), h: 0.45 + Math.random() * 0.8 });
        }
        createGrassPatch(pts);
        createBush(cx, z1 - 3.5, FLOOR_SURFACE_Y + H, 0.75, 1);
        createBush(cx, z0 + 3.0, FLOOR_SURFACE_Y + H, 0.6, 2);
      });
      placeModel('mushroom_02', { x: BOWLING.x - 12.4, z: BOWLING.zStart + 16, y: FLOOR_SURFACE_Y + 0.12, isStatic: true, r: 1.2, rotY: 0.6 });
      placeModel('mushroom_03', { x: BOWLING.x + 12.2, z: BOWLING.zStart + 24, y: FLOOR_SURFACE_Y + 0.12, isStatic: true, r: 1.3, rotY: 2.1 });
    })();
    // Atalho escondido com cara de passagem secreta: mato denso dos dois lados (entrada, apoio de pés e saída)
    (function secretPassageFoliage() {
      const PATH = [[0, -37.5], [2, -30], [4, -24], [4, -18], [4, -10], [4, -4], [4, 4], [5, 11], [7, 19], [9, 25], [11, 28.5]];
      const floorTrack = trackSamples.filter(s => s.level === 'floor');
      const nearMainTrack = (x, z, m) => floorTrack.some(s => (s.x - x) ** 2 + (s.z - z) ** 2 < (TRACK_WIDTH / 2 + m) ** 2);
      const blocked = (x, z) => (x > 14.5 && x < 21.5 && z > -31 && z < -13)   // filtro de linha
        || Math.hypot(x + 6, z - 20) < 7.5                                       // galão do Portal 5
        || (x > -4 && x < 12 && z > -16.5 && z < -3.5);                          // placa do apoio de pés
      let seed = 4242;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const grassPts = [];
      for (let i = 0; i < PATH.length - 1; i++) {
        const [ax, az] = PATH[i], [bx, bz] = PATH[i + 1];
        const len = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / len, tz = (bz - az) / len, nx = -tz, nz = tx;
        for (let d = 0; d < len; d += 2.2) {
          const cx = ax + tx * d, cz = az + tz * d;
          [-1, 1].forEach((side) => {
            // Arbustos encostados na beira do caminho (fazem o "túnel" verde)
            const off = 5.2 + rnd() * 2.6;
            const x = cx + nx * side * off, z = cz + nz * side * off;
            if (!blocked(x, z) && !nearMainTrack(x, z, 2.5) && rnd() < 0.55) {
              createBush(x, z, FLOOR_SURFACE_Y, 0.45 + rnd() * 0.4, Math.floor(rnd() * 3));
            }
            // Capim alto e matinhos invadindo a borda (sem cobrir o meio da pista)
            for (let g = 0; g < 26; g++) {
              const o = 4.0 + rnd() * 5.5, a = (rnd() - 0.5) * 2.2;
              const gx = cx + nx * side * o + tx * a, gz = cz + nz * side * o + tz * a;
              if (blocked(gx, gz) || nearMainTrack(gx, gz, 0.6)) continue;
              grassPts.push({ x: gx, y: FLOOR_SURFACE_Y, z: gz, h: 0.7 + rnd() * 1.5 });
            }
          });
        }
      }
      createGrassPatch(grassPts);
      // Cogumelos, pedrinhas e uma placa escondida "atalho?" na entrada
      [[-7, -27, 'mushroom_01', 0.7], [11, -27, 'mushroom_03', 0.6], [-6, 8, 'mushroom_02', 0.7], [14, 14, 'mushroom_01', 0.55], [16, 23, 'rock_01', 0.6], [-5, -20, 'rock_02', 0.5]].forEach(([x, z, key, s]) => {
        if (!blocked(x, z) && !nearMainTrack(x, z, 2)) placeModel(key, { x, z, floor: true, scale: s, physics: false, rotY: rnd() * 6 });
      });
      placeModel('finger_post_sign_01', { x: -4.5, z: -29, floor: true, scale: 0.55, rotY: 0.6, physics: false, name: 'Placa do Atalho' });
    })();
    // Marcações da pista: linha de falta, pontos-guia e flechas extras
    (function bowlingLaneMarks() {
      const markMat = new THREE.MeshBasicMaterial({ color: 0x2b1d2e });
      const foul = new THREE.Mesh(new THREE.PlaneGeometry(12, 0.25), new THREE.MeshBasicMaterial({ color: 0xc21515 }));
      foul.rotation.x = -Math.PI / 2;
      foul.position.set(BOWLING.x, FLOOR_SURFACE_Y + 0.06, BOWLING.zStart + 8.5);
      scene.add(foul);
      [-3.6, -1.8, 0, 1.8, 3.6].forEach((dx) => {
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), markMat);
        dot.rotation.x = -Math.PI / 2;
        dot.position.set(BOWLING.x + dx, FLOOR_SURFACE_Y + 0.06, BOWLING.zStart + 10.5);
        scene.add(dot);
      });
    })();
    // Placar 3D atrás dos pinos (virado para quem vem jogar)
    const bowlingBoard = (() => {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 256;
      const tex = new THREE.CanvasTexture(c);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x251f2b, roughness: 0.6 });
      const board = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 0.4), [frameMat, frameMat, frameMat, frameMat, frameMat, new THREE.MeshBasicMaterial({ map: tex })]);
      board.position.set(BOWLING.x, FLOOR_SURFACE_Y + 9.5, BOWLING.zEnd - 1.2);
      [-1, 1].forEach((s) => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.6, 0.5), frameMat);
        post.position.set(BOWLING.x + s * 5.6, FLOOR_SURFACE_Y + 3.3, BOWLING.zEnd - 1.2);
        scene.add(post);
      });
      scene.add(board);
      return { c, ctx: c.getContext('2d'), tex };
    })();
    function drawBowlingBoard() {
      const { ctx, tex } = bowlingBoard;
      const g = bowlingGame;
      ctx.fillStyle = '#1d1721'; ctx.fillRect(0, 0, 512, 256);
      ctx.strokeStyle = '#ffceca'; ctx.lineWidth = 6; ctx.strokeRect(6, 6, 500, 244);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffceca'; ctx.font = 'bold 44px "Amatic SC", sans-serif';
      ctx.fillText(g.active ? `JOGADA ${Math.max(1, g.throwNo)}` : 'BOLICHE', 256, 42);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 78px Nunito, sans-serif';
      ctx.fillText(String(g.total), 256, 120);
      ctx.font = 'bold 24px Nunito, sans-serif';
      ctx.fillStyle = '#d5ff95';
      ctx.fillText(g.lastText || (g.active ? 'Empurre a bola!' : 'Aperte o ponto do boliche para jogar'), 256, 180);
      ctx.fillStyle = '#ffc67b'; ctx.font = '22px Nunito, sans-serif';
      const globalTop = window.__globalBowlingTop || 0;
      ctx.fillText(globalTop > bowlingBest ? `Strikes: ${g.strikes} · Seu: ${bowlingBest} · Global: ${globalTop}` : `Strikes: ${g.strikes}   ·   Recorde: ${bowlingBest}`, 256, 222);
      tex.needsUpdate = true;
    }
    drawBowlingBoard();

    function inBowlingArea(x, z) {
      return x > BOWLING_AREA.x0 && x < BOWLING_AREA.x1 && z > BOWLING_AREA.z0 && z < BOWLING_AREA.z1;
    }
    // Carrinho de frente para a bola, no começo da pista
    function placeCarForBowling() {
      teleportVehicle({ name: 'Boliche', x: BOWLING.x, z: bowlingBall.initZ - 7, angle: 0, silent: true, floor: true });
      carSpeed = 0;
      if (typeof closeCamAngle !== 'undefined') closeCamAngle = 0;
    }
    function startBowlingGame() {
      if (raceState !== 'idle') endRace(true);
      Object.assign(bowlingGame, { active: true, phase: 'aim', t: 0, throwNo: 1, total: 0, strikes: 0, lastText: '' });
      resetBowling();
      placeCarForBowling();
      setCameraMode('close');
      drawBowlingBoard();
      notify({ type: 'info', title: '🎳 Boliche!', description: 'Empurre a bola contra os pinos. Sair da área encerra o jogo.', duration: 4000 });
      showCarSpeech('Vamos jogar boliche!', 2000);
    }
    function endBowlingGame(reason) {
      if (!bowlingGame.active) return;
      const throwsDone = bowlingGame.throwNo - (bowlingGame.phase === 'aim' ? 1 : 0);
      bowlingGame.active = false;
      bowlingGame.phase = 'idle';
      if (bowlingGame.total > bowlingBest) {
        bowlingBest = bowlingGame.total;
        try { localStorage.setItem(BOWLING_BEST_KEY, String(bowlingBest)); } catch (e) { /* ignora */ }
        try { cloudSubmitBowling(bowlingBest); } catch (e) { /* nuvem indisponível */ }
      }
      bowlingGame.lastText = `Fim de jogo: ${bowlingGame.total} pontos`;
      drawBowlingBoard();
      notify({ type: 'info', title: 'Boliche encerrado', description: `${reason || ''} Total: ${bowlingGame.total} pontos em ${throwsDone} jogada(s).`.trim(), duration: 4500 });
    }
    function scoreBowlingThrow() {
      const g = bowlingGame;
      const down = bowlingPins.filter(p => p.knocked).length;
      const strike = down === bowlingPins.length;
      const pts = down + (strike ? 10 : 0); // strike vale bônus de 10
      g.total += pts;
      if (strike) g.strikes++;
      g.lastText = strike ? `STRIKE! +${pts}` : down ? `${down} pino${down > 1 ? 's' : ''}: +${pts}` : 'Nenhum pino... tente de novo!';
      drawBowlingBoard();
      if (strike) {
        notify({ type: 'achievement', title: 'STRIKE!', description: 'Todos os 10 pinos derrubados! +20 pontos', progress: '10 / 10', duration: 4500 });
        confettiBurst(BOWLING.x, FLOOR_SURFACE_Y + 3, BOWLING.pinsZ + 3, 90);
        unlockAchievement('bowling');
      } else {
        notify({ type: 'info', title: `Jogada ${g.throwNo}: ${down} pino${down === 1 ? '' : 's'}`, description: `Total: ${g.total} pontos`, duration: 3000 });
      }
      playTone(strike ? 880 : 520, 0, 0.15, 'triangle', 0.06);
      g.flash = strike ? 2.4 : 0.8;
    }
    function updateBowlingGame(time, dt) {
      const g = bowlingGame;
      // LEDs: ondas que correm para os pinos; mais rápidas com a bola rolando; arco-íris no strike
      const col = new THREE.Color();
      const rolling = g.phase === 'rolling';
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < BOWLING_LEDS_PER_SIDE; i++) {
          const k = i / BOWLING_LEDS_PER_SIDE;
          if (g.flash > 0) col.setHSL((time * 1.5 + k) % 1, 1, 0.55);
          else {
            const wave = 0.5 + 0.5 * Math.sin((k * 8 - time * (rolling ? 14 : g.active ? 5 : 2)));
            // Ciano forte em ondas; esperando a jogada = rosa/magenta do DS; bola rolando = ciano acelerado
            if (g.active && !rolling) col.setHSL(0.88, 1, 0.32 + wave * 0.3);
            else col.setHSL(0.52, 1, 0.28 + wave * 0.32);
          }
          bowlingLeds.setColorAt(s * BOWLING_LEDS_PER_SIDE + i, col);
        }
      }
      bowlingLeds.instanceColor.needsUpdate = true;
      if (g.flash > 0) g.flash = Math.max(0, g.flash - dt);
      if (!g.active) return;

      // Sair da área do boliche encerra o evento
      const vp = vehicle.position;
      if (!inBowlingArea(vp.x, vp.z) || vp.y > -15) { endBowlingGame('Você saiu da área do boliche.'); return; }

      const b = bowlingBall;
      const ballSpeed = Math.hypot(b.vx, b.vz);
      g.t += dt;
      if (g.phase === 'aim') {
        const moved = Math.hypot(b.x - b.initX, b.z - b.initZ);
        if (ballSpeed > 0.04 || moved > 0.8 || bowlingPins.some(p => p.knocked)) { g.phase = 'rolling'; g.t = 0; }
      } else if (g.phase === 'rolling') {
        const passedPins = b.z > BOWLING.pinsZ + 7.5 || b.x < BOWLING.x - 7 || b.x > BOWLING.x + 7;
        if ((g.t > 1.2 && ballSpeed < 0.015) || passedPins || g.t > 8) { g.phase = 'counting'; g.t = 0; }
      } else if (g.phase === 'counting') {
        if (g.t > 2.4) { scoreBowlingThrow(); g.phase = 'refresh'; g.t = 0; }
      } else if (g.phase === 'refresh') {
        if (g.t > 2.2) {
          // Monta de novo os pinos, bola centralizada e carrinho de frente para ela
          resetBowling();
          placeCarForBowling();
          g.throwNo++;
          g.phase = 'aim';
          g.t = 0;
          g.lastText = '';
          drawBowlingBoard();
          showCarSpeech(`Jogada ${g.throwNo}!`, 1400);
        }
      }
    }

    // ============================================================================
    // CARRINHO DO RAVI: //Fire Engine// (MODELO 3D FIEL AOS 4 ÂNGULOS REAIS!)
    // ============================================================================
    const vehicle = new THREE.Group();

    const carOrangeMat = new THREE.MeshStandardMaterial({
      color: 0xff4518,
      roughness: 0.13, // Plástico laranja-avermelhado injetado super brilhante
      metalness: 0.04
    });
    const carWhiteSkirtMat = new THREE.MeshStandardMaterial({
      color: 0xe6eae8,
      roughness: 0.22
    });
    const cyanWheelMat = new THREE.MeshStandardMaterial({
      color: 0x38d9e8,
      roughness: 0.18
    });
    const tireDarkMat = new THREE.MeshStandardMaterial({
      color: 0x16191d,
      roughness: 0.65
    });
    const yellowDetailMat = new THREE.MeshStandardMaterial({
      color: 0xffcf48,
      roughness: 0.18
    });
    const speakerHoleMat = new THREE.MeshBasicMaterial({ color: 0x260804 });
    // Janelas laterais com material próprio (personalizável como "vidro" na Ilha das Cores)
    const sideWindowMat = new THREE.MeshStandardMaterial({ color: 0xffcf48, roughness: 0.18 });

    // ---------- Pinturas especiais da carroceria (shader no próprio material) ----------
    // Modo 0 = cor lisa · 1 = Chamas (estilo Hot Wheels) · 2 = Abissal (azul-marinho com estrelas)
    // O desenho usa a posição no espaço do CARRINHO, então fica contínuo em todas as peças da carroceria.
    const paintUniforms = { uPaintMode: { value: 0 }, uCarInv: { value: new THREE.Matrix4() }, uPaintTime: { value: 0 } };
    carOrangeMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, paintUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform mat4 uCarInv;
          varying vec3 vCarPos;
          varying vec3 vCarNormal;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vCarPos = (uCarInv * modelMatrix * vec4(transformed, 1.0)).xyz;
          vCarNormal = normalize(mat3(uCarInv) * mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uPaintMode;
          uniform float uPaintTime;
          varying vec3 vCarPos;
          varying vec3 vCarNormal;
          vec3 paintGlow = vec3(0.0);
          float pHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          vec3 paintFlames(vec3 p, vec3 n) {
            // t: 0 na frente do carrinho → 1 na traseira
            float t = clamp((1.95 - p.z) / 3.7, 0.0, 1.0);
            bool top = n.y > 0.55;
            float lateral = top ? abs(p.x) * 1.25 : abs(p.y - 1.2);
            // Línguas de fogo: largas na frente, afinando em pontas onduladas para trás
            // Pontas bem marcadas: |sen| elevado gera línguas separadas que afinam rumo à traseira
            float tongues = pow(abs(sin(t * 8.5 + (top ? 0.0 : 0.9) + sin(t * 3.0) * 0.8)), 0.55);
            float amp = (0.58 * pow(1.0 - t, 0.75) * (0.35 + 0.65 * tongues) + 0.015) * step(t, 0.92);
            float r = lateral / max(amp, 0.001);
            vec3 base = vec3(0.24, 0.015, 0.03);
            if (r > 1.06 || amp < 0.02) return base;
            vec3 col = mix(vec3(1.0, 0.88, 0.25), vec3(1.0, 0.45, 0.02), smoothstep(0.1, 0.5, r));
            col = mix(col, vec3(0.82, 0.08, 0.02), smoothstep(0.5, 0.82, r));
            float outline = smoothstep(0.82, 0.9, r);
            col = mix(col, vec3(0.12, 0.0, 0.015), outline);
            col = mix(col, base, smoothstep(0.98, 1.06, r));
            paintGlow = col * (1.0 - smoothstep(0.3, 0.8, r)) * 0.12;
            return col;
          }
          vec3 paintAbyssal(vec3 p) {
            vec3 col = mix(vec3(0.02, 0.03, 0.12), vec3(0.14, 0.05, 0.26), smoothstep(0.4, 2.4, p.y));
            vec3 cell = floor(p * 11.0);
            float h = pHash(cell);
            if (h > 0.9) {
              vec3 center = (cell + 0.5 + (vec3(pHash(cell + 1.3), pHash(cell + 2.7), pHash(cell + 4.1)) - 0.5) * 0.6) / 11.0;
              float d = length(p - center) * 11.0;
              float tw = 0.6 + 0.4 * sin(uPaintTime * 3.0 + h * 40.0);
              float star = (1.0 - smoothstep(0.0, 0.22 + (h - 0.9) * 2.0, d)) * tw;
              col += vec3(0.85, 0.9, 1.0) * star;
              paintGlow = vec3(0.7, 0.8, 1.0) * star * 0.8;
            }
            return col;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uPaintMode > 0.5 && uPaintMode < 1.5) diffuseColor.rgb = paintFlames(vCarPos, normalize(vCarNormal));
          else if (uPaintMode > 1.5) diffuseColor.rgb = paintAbyssal(vCarPos);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += paintGlow;`);
    };
    carOrangeMat.customProgramCacheKey = () => 'car-paint-v1';
    function updatePaintUniforms(time) {
      paintUniforms.uPaintTime.value = time;
    }

    const carBodyGroup = new THREE.Group();
    vehicle.add(carBodyGroup);

    // ============================================================================
    // CARRO BAJA 13 · PIRATAS DO VALE (UNESP) — modelo procedural feito a partir das fotos reais:
    // gaiola tubular azul com espuma preta no arco superior, carenagem preta com padrão
    // geométrico roxo/azul, capô com a caveira "PIRATAS DO VALE 1997", painel corta-fogo alto
    // com o 13 dourado, braços de suspensão pretos com amortecedores coilover, pneus ATV com
    // cravos e aro preto, extintor vermelho, placa lateral 13, motor/CVT atrás e bandeirinha laranja.
    // ============================================================================
    const bajaBodyGroup = new THREE.Group();
    bajaBodyGroup.visible = false;
    vehicle.add(bajaBodyGroup);
    let currentVehicleType = 'truck';
    let bajaDirt = 0; // 0 = limpo, 1 = coberto de lama

    function bajaCanvas(w, h, draw) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.anisotropy = 4;
      return t;
    }
    function bajaPattern(ctx, w, h) {
      ctx.fillStyle = '#0d0e14'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 46; i++) {
        const x = Math.random() * w, y = Math.random() * h, s = 18 + Math.random() * 60;
        ctx.fillStyle = ['rgba(88,40,190,0.55)', 'rgba(40,60,200,0.45)', 'rgba(130,60,220,0.35)', 'rgba(20,20,40,0.6)'][i % 4];
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y + s * 0.3); ctx.lineTo(x + s * 0.2, y + s); ctx.closePath(); ctx.fill();
      }
    }
    function drawSkull(ctx, cx, cy, s) {
      ctx.save();
      ctx.strokeStyle = '#c9c4b8'; ctx.lineWidth = s * 0.09; ctx.lineCap = 'round';
      [[-1, 1], [1, 1]].forEach(([a]) => { ctx.beginPath(); ctx.moveTo(cx - s * 1.1 * a, cy - s * 0.2); ctx.lineTo(cx + s * 1.1 * a, cy + s * 0.9); ctx.stroke(); });
      ctx.fillStyle = '#efe9da';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(cx - s * 0.32, cy + s * 0.3, s * 0.64, s * 0.38);
      ctx.fillStyle = '#0d0e14';
      [-1, 1].forEach((a) => { ctx.beginPath(); ctx.arc(cx + a * s * 0.22, cy, s * 0.15, 0, Math.PI * 2); ctx.fill(); });
      ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.12); ctx.lineTo(cx - s * 0.07, cy + s * 0.27); ctx.lineTo(cx + s * 0.07, cy + s * 0.27); ctx.fill();
      ctx.fillStyle = '#b3202a'; // bandana de pirata
      ctx.beginPath(); ctx.ellipse(cx, cy - s * 0.32, s * 0.6, s * 0.24, 0, Math.PI, 0); ctx.fill();
      ctx.restore();
    }
    const bajaTex = {
      panel: bajaCanvas(256, 256, bajaPattern),
      hood: bajaCanvas(512, 384, (ctx, w, h) => {
        bajaPattern(ctx, w, h);
        drawSkull(ctx, w / 2, h * 0.42, 70);
        ctx.fillStyle = '#e2b866'; ctx.textAlign = 'center';
        ctx.font = 'bold 54px "Amatic SC", serif'; ctx.fillText('PIRATAS DO VALE', w / 2, h * 0.82);
        ctx.font = 'bold 32px "Amatic SC", serif'; ctx.fillText('1997', w / 2, h * 0.93);
      }),
      firewall: bajaCanvas(256, 384, (ctx, w, h) => {
        ctx.fillStyle = '#0f1015'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
        ctx.font = 'bold 15px sans-serif';
        ['SOLIDWORKS', 'UWN', 'ALTAIR', 'CIGS', 'prograd', 'SAE BRASIL'].forEach((t, i) => ctx.fillText(t, 18 + (i % 2) * 128, 34 + Math.floor(i / 2) * 26 + (i > 3 ? 250 : 0)));
        ctx.fillStyle = '#e2b866';
        ctx.font = 'bold 150px Georgia, "Times New Roman", serif'; ctx.textAlign = 'center';
        ctx.fillText('13', w / 2, 240);
      }),
      plate: bajaCanvas(128, 160, (ctx, w, h) => {
        ctx.fillStyle = '#f4f4ef'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#111'; ctx.font = 'bold 96px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('13', w / 2, 118);
        ctx.font = 'bold 14px sans-serif'; ctx.fillText('SAE BRASIL', w / 2, 148);
      })
    };

    // Monta um Baja completo; retorna as peças animáveis (rodas, suspensão, bandeira, materiais sujáveis)
    function buildBajaModel() {
      const root = new THREE.Group();
      const body = new THREE.Group();
      root.add(body);
      const M = {
        tube: new THREE.MeshStandardMaterial({ color: 0x2f55c8, metalness: 0.55, roughness: 0.32 }),
        foam: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.95 }),
        panel: new THREE.MeshStandardMaterial({ map: bajaTex.panel, roughness: 0.45, metalness: 0.15 }),
        hood: new THREE.MeshStandardMaterial({ map: bajaTex.hood, roughness: 0.4, metalness: 0.15 }),
        firewall: new THREE.MeshStandardMaterial({ map: bajaTex.firewall, roughness: 0.5 }),
        plate: new THREE.MeshStandardMaterial({ map: bajaTex.plate, roughness: 0.6 }),
        black: new THREE.MeshStandardMaterial({ color: 0x18191d, roughness: 0.55, metalness: 0.3 }),
        engine: new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.5, metalness: 0.5 }),
        silver: new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.25, metalness: 0.85 }),
        spring: new THREE.MeshStandardMaterial({ color: 0xe8c547, roughness: 0.35, metalness: 0.5 }),
        tire: new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.95, flatShading: true }),
        red: new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.35, metalness: 0.2 }),
        suit: new THREE.MeshStandardMaterial({ color: 0x2457c5, roughness: 0.7 }),
        helmet: new THREE.MeshStandardMaterial({ color: 0x3a7bd5, roughness: 0.25, metalness: 0.2 }),
        visor: new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.05, metalness: 0.6 }),
        flag: new THREE.MeshStandardMaterial({ color: 0xff8a1a, roughness: 0.6, side: THREE.DoubleSide })
      };
      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      const up = new THREE.Vector3(0, 1, 0);
      function tube(a, b, r, mat, parent = body) {
        const d = new THREE.Vector3().subVectors(b, a);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
        m.position.copy(a).addScaledVector(d, 0.5);
        m.quaternion.setFromUnitVectors(up, d.normalize());
        m.castShadow = true;
        parent.add(m);
        return m;
      }
      function box(w, h, d, mat, x, y, z, parent = body) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        parent.add(m);
        return m;
      }
      const R = 0.05; // raio dos tubos
      // --- Gaiola (vista das fotos: arco traseiro alto, barras do teto, montantes dianteiros, para-choque em laço) ---
      [-1, 1].forEach((sx) => {
        const rb = V(0.66 * sx, 0.82, -0.55), rt = V(0.52 * sx, 2.62, -0.55);
        const ft = V(0.5 * sx, 2.5, 0.3), fl = V(0.62 * sx, 1.25, 1.3), fb = V(0.6 * sx, 0.82, 1.55);
        tube(rb, rt, R, M.tube);                         // arco traseiro
        tube(rt, ft, R, M.tube);                         // barra do teto
        tube(ft, fl, R, M.tube);                         // montante dianteiro
        tube(fl, fb, R, M.tube);
        tube(rb, fb, R, M.tube);                         // longarina inferior
        tube(V(0.68 * sx, 1.32, -0.55), fl, R * 0.9, M.tube); // barra de impacto lateral
        tube(rt, V(0.42 * sx, 1.15, -1.55), R * 0.9, M.tube); // escora traseira
        tube(rb, V(0.42 * sx, 0.82, -1.6), R * 0.9, M.tube);
        tube(rt, ft, R * 2.1, M.foam);                   // espuma preta nas barras do teto
      });
      tube(V(-0.52, 2.62, -0.55), V(0.52, 2.62, -0.55), R, M.tube);
      tube(V(-0.52, 2.62, -0.55), V(0.52, 2.62, -0.55), R * 2.2, M.foam);
      tube(V(-0.5, 2.5, 0.3), V(0.5, 2.5, 0.3), R, M.tube);
      tube(V(-0.5, 2.5, 0.3), V(0.5, 2.5, 0.3), R * 2.2, M.foam);
      tube(V(-0.62, 1.25, 1.3), V(0.62, 1.25, 1.3), R, M.tube);
      tube(V(-0.42, 1.15, -1.55), V(0.42, 1.15, -1.55), R, M.tube);
      // Para-choque dianteiro em laço (azul, como na foto da oficina)
      const bumperCurve = new THREE.CatmullRomCurve3([V(-0.55, 0.95, 1.55), V(-0.5, 0.98, 1.92), V(0, 1.0, 2.02), V(0.5, 0.98, 1.92), V(0.55, 0.95, 1.55)]);
      const bumper = new THREE.Mesh(new THREE.TubeGeometry(bumperCurve, 20, R * 1.1, 8, false), M.tube);
      bumper.castShadow = true;
      body.add(bumper);

      // --- Carenagem ---
      box(1.3, 0.1, 3.0, M.black, 0, 0.8, 0);                       // assoalho
      [-1, 1].forEach((sx) => {
        const side = box(0.04, 0.62, 1.9, M.panel, 0.68 * sx, 1.13, 0.3);
        side.rotation.z = 0.05 * sx;
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.52), M.plate);
        plate.position.set(0.705 * sx, 1.13, -0.25);
        plate.rotation.y = sx * Math.PI / 2;
        body.add(plate);
      });
      // Bico/capô inclinado com a caveira
      box(1.2, 0.5, 0.75, M.panel, 0, 1.05, 1.42);
      const hood = box(1.18, 0.05, 1.1, M.hood, 0, 1.42, 0.95);
      hood.rotation.x = 0.32;
      box(1.18, 0.5, 0.04, M.panel, 0, 1.15, 1.8);                   // frente do bico
      // Corta-fogo alto atrás do banco com o 13 dourado
      const fw = box(1.22, 1.75, 0.05, M.firewall, 0, 1.72, -0.5);
      fw.rotation.x = -0.06;
      // Banco, piloto de capacete azul e volante
      box(0.6, 0.18, 0.62, M.black, 0, 1.0, -0.12);
      box(0.6, 0.9, 0.14, M.black, 0, 1.45, -0.4);
      const torso = box(0.56, 0.62, 0.42, M.suit, 0, 1.45, -0.18);
      torso.rotation.x = -0.15;
      [-1, 1].forEach((sx) => tube(V(0.25 * sx, 1.62, -0.1), V(0.2 * sx, 1.55, 0.42), 0.08, M.suit));
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), M.helmet);
      helmet.position.set(0, 2.0, -0.13);
      helmet.castShadow = true;
      body.add(helmet);
      const visor = new THREE.Mesh(new THREE.SphereGeometry(0.275, 16, 8, -0.9, 1.8, 1.2, 0.55), M.visor);
      visor.position.copy(helmet.position);
      body.add(visor);
      const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 6, 18), M.black);
      wheelRing.position.set(0, 1.62, 0.5);
      wheelRing.rotation.x = -0.6;
      body.add(wheelRing);
      // Motor + CVT atrás, escapamento e extintor vermelho na lateral
      box(0.8, 0.6, 0.8, M.engine, 0, 1.12, -1.15);
      box(0.12, 0.55, 0.7, M.silver, -0.48, 1.08, -1.12);
      tube(V(0.3, 1.25, -1.45), V(0.38, 1.4, -1.75), 0.06, M.silver);
      const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 10), M.red);
      ext.position.set(-0.74, 1.45, -0.62);
      body.add(ext);
      // Bandeirinha laranja na antena (dobra com o vento e a velocidade)
      tube(V(0.45, 2.62, -0.6), V(0.5, 3.75, -0.7), 0.018, M.black);
      const flagPivot = new THREE.Group();
      flagPivot.position.set(0.5, 3.6, -0.7);
      const flagMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), M.flag);
      flagMesh.position.set(0, 0, -0.25);
      flagMesh.rotation.y = Math.PI / 2;
      flagPivot.add(flagMesh);
      body.add(flagPivot);

      // --- Suspensão (braços A pretos + coilover) e rodas ATV ---
      const knobGeo = new THREE.BoxGeometry(0.16, 0.1, 0.15);
      const wheels = [];
      [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
        const wx = 1.22 * sx, wz = 1.32 * sz, wy = 0.62;
        const wheel = new THREE.Group();
        wheel.position.set(wx, wy, wz);
        const spin = new THREE.Group();
        wheel.add(spin);
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.48, 18), M.tire);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        spin.add(tire);
        const knobs = new THREE.InstancedMesh(knobGeo, M.tire, 36);
        const d = new THREE.Object3D();
        for (let i = 0; i < 36; i++) {
          const a = (i / 18) * Math.PI * 2 + (i >= 18 ? Math.PI / 18 : 0);
          d.position.set((i >= 18 ? 0.12 : -0.12), Math.cos(a) * 0.62, Math.sin(a) * 0.62);
          d.rotation.set(-a, 0, 0);
          d.updateMatrix();
          knobs.setMatrixAt(i, d.matrix);
        }
        knobs.castShadow = true;
        spin.add(knobs);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 10), M.black);
        rim.rotation.z = Math.PI / 2;
        spin.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.54, 8), M.silver);
        hub.rotation.z = Math.PI / 2;
        spin.add(hub);
        root.add(wheel);
        // Braços (do chassi até o cubo) e amortecedor inclinado
        const arms = new THREE.Group();
        root.add(arms);
        const A1 = tube(V(0.55 * sx, 0.85, wz + 0.25), V(wx - 0.22 * sx, wy, wz), 0.035, M.black, arms);
        const A2 = tube(V(0.55 * sx, 0.85, wz - 0.25), V(wx - 0.22 * sx, wy, wz), 0.035, M.black, arms);
        const A3 = tube(V(0.55 * sx, 1.08, wz), V(wx - 0.22 * sx, wy + 0.2, wz), 0.03, M.black, arms);
        const shockTop = V(0.6 * sx, 1.75, wz - 0.12 * sz);
        const shock = tube(shockTop, V(wx - 0.3 * sx, wy + 0.1, wz), 0.035, M.silver, arms);
        const helixPts = [];
        for (let i = 0; i <= 60; i++) { const a = i / 60 * Math.PI * 14; helixPts.push(V(Math.cos(a) * 0.07, i / 60 * 0.5 - 0.25, Math.sin(a) * 0.07)); }
        const spring = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helixPts), 120, 0.014, 4, false), M.spring);
        spring.position.copy(shock.position);
        spring.quaternion.copy(shock.quaternion);
        arms.add(spring);
        wheels.push({ wheel, spin, arms, baseY: wy, front: sz > 0, parts: [A1, A2, A3, shock, spring] });
      });
      const dirtMats = [M.panel, M.hood, M.firewall, M.tire, M.black, M.tube, M.suit];
      dirtMats.forEach((m) => { m.userData.baseColor = m.color.clone(); });
      return { root, body, wheels, flag: flagPivot, dirtMats };
    }
    const bajaCar = buildBajaModel();
    bajaBodyGroup.add(bajaCar.root);
    // Baja de exposição no pódio da ilha (mesmo modelo, um pouco maior)
    IS_QUINTAL && (function bajaPodium() {
      const show = buildBajaModel();
      show.root.scale.setScalar(1.35);
      show.root.position.set(185, ISLAND_Y + 1.2, 68);
      show.root.rotation.y = -0.65;
      bedroomWorld.add(show.root);
      const pMat = new THREE.MeshStandardMaterial({ color: 0x1f2227, roughness: 0.5, metalness: 0.4 });
      const standBase = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.8, 1.2, 32), pMat);
      standBase.position.set(185, ISLAND_Y + 0.6, 68);
      standBase.castShadow = true; standBase.receiveShadow = true;
      bedroomWorld.add(standBase);
      obstacles.push({ x: 185, z: 68, r: 4.8, h: 1.2 + 3.6, name: 'PÓDIO DO BAJA 13', isStatic: true, level: 'floor' });
    })();
    const _mudColor = new THREE.Color(0x5a3a22);
    function applyBajaDirt() {
      bajaCar.dirtMats.forEach((m) => { m.color.copy(m.userData.baseColor).lerp(_mudColor, bajaDirt * (m === bajaCar.dirtMats[3] ? 0.75 : 0.5)); });
    }
    // Suspensão visual do Baja: mola do chassi + curso independente de cada roda no terreno
    const bajaSusp = { y: 0, v: 0, lastVy: 0 };
    function updateBajaVisual(speed, steer, vertVel, onRough) {
      const s = bajaSusp;
      s.v += -(vertVel - s.lastVy) * 0.9;
      s.lastVy = vertVel;
      s.v += -s.y * 0.22;
      s.v *= 0.78;
      s.y = clamp(s.y + s.v, -0.22, 0.22);
      bajaCar.body.position.y = s.y + (onRough ? Math.sin(performance.now() * 0.05) * 0.02 * Math.min(1, Math.abs(speed) * 4) : 0);
      const ca = Math.cos(carAngle), sa = Math.sin(carAngle);
      const px = vehicle.position.x, pz = vehicle.position.z;
      const hC = rallyHeightAt(px, pz);
      bajaCar.wheels.forEach((w) => {
        w.spin.rotation.x += speed * 1.7;
        if (w.front) w.wheel.rotation.y = steer * 0.4;
        // Altura do terreno sob a roda (obstáculos do rally): cada roda sobe/desce sozinha
        const lx = w.wheel.position.x, lz = w.wheel.position.z;
        const wx = px + lx * ca + lz * sa, wz = pz - lx * sa + lz * ca;
        const off = onRough ? clamp(rallyHeightAt(wx, wz) - hC, -0.35, 0.35) : 0;
        w.wheel.position.y += (w.baseY + off - w.wheel.position.y) * 0.4;
        w.arms.position.y = (w.wheel.position.y - w.baseY) * 0.5;
      });
      // Bandeira aponta para trás com a velocidade e tremula com o vento
      bajaCar.flag.rotation.y = Math.sin(performance.now() * 0.012) * (0.35 - Math.min(0.3, Math.abs(speed)));
      bajaCar.flag.rotation.z = Math.sin(performance.now() * 0.02) * 0.15;
    }

    // Cambalhota do Baja: para frente ou de lado. Manual (F no ar; com seta = de lado) ou capotando
    // sozinho numa aterrissagem muito forte ou numa encosta inclinada demais.
    const bajaFlip = { active: false, type: 'front', dir: 1, angle: 0 };
    function startBajaFlip(type, dir, crash) {
      if (bajaFlip.active || currentVehicleType !== 'baja' || isSomersaulting) return;
      Object.assign(bajaFlip, { active: true, type, dir: dir || 1, angle: 0 });
      if (!carAirborne) launchVehicle(0.42); else fallVelocityY = Math.max(fallVelocityY, 0.24);
      if (crash) carSpeed *= 0.55;
      showCarSpeech(crash ? (type === 'front' ? 'Capotei pra frente! 🤸' : 'Capotei de lado! 🤸') : (type === 'front' ? 'Cambalhota! 🤸' : 'Giro lateral! 🌀'), 1800);
      if (!sfx('flip', { vol: 0.55 })) { playTone(330, 0, 0.12, 'triangle', 0.06); playTone(495, 0.12, 0.14, 'triangle', 0.05); }
      rumble(0.5, 0.8, 220);
      unlockAchievement('acrobat');
    }
    function stepBajaFlip(dt) {
      const f = bajaFlip;
      if (!f.active) return;
      f.angle = Math.min(Math.PI * 2, f.angle + dt * (Math.PI * 2 / 0.6) * (carAirborne ? 1 : 2.2));
      const a = f.angle, h = 1.1;
      if (f.type === 'front') {
        bajaBodyGroup.rotation.set(a, 0, 0);
        bajaBodyGroup.position.set(0, h * (1 - Math.cos(a)), -h * Math.sin(a));
      } else {
        const b2 = a * f.dir;
        bajaBodyGroup.rotation.set(0, 0, b2);
        bajaBodyGroup.position.set(h * Math.sin(b2), h * (1 - Math.cos(a)), 0);
      }
      carSpeed *= 0.995;
      if (f.angle >= Math.PI * 2) {
        f.active = false;
        bajaBodyGroup.rotation.set(0, 0, 0);
        bajaBodyGroup.position.set(0, 0, 0);
      }
    }
    // Largada da pista de rally (logo depois da linha quadriculada, apontando no sentido da volta)
    function rallyStartLocation() {
      const s = rallySampleAt(0.012);
      return { x: s.x, z: s.z, angle: Math.atan2(s.tx, s.tz), floor: true, silent: true, name: 'Largada do Rally Baja' };
    }
    function switchVehicleModel(type) {
      currentVehicleType = type;
      const baja = type === 'baja';
      carBodyGroup.visible = !baja;
      bajaBodyGroup.visible = baja;
      wheels.forEach((w) => { w.visible = !baja; });
      keys.spray = false;
      setSirenSound(false);
      bajaFlip.active = false;
      bajaBodyGroup.rotation.set(0, 0, 0);
      bajaBodyGroup.position.set(0, 0, 0);
      const waterBtn = document.getElementById('t-water');
      if (waterBtn) waterBtn.style.display = baja ? 'none' : '';
      if (baja) {
        teleportVehicle(rallyStartLocation());
        rallyLap.active = false;
        showCarSpeech('🏁 Baja 13 na largada! Acelera!', 2800);
        setStatusBanner('🏎️ Baja 13: só ele anda na lama e sobe troncos, pedras, morro e pneus. Sem mangueira e sem sirene!', '#ffb703');
        notify({ type: 'success', title: 'Baja 13 · Piratas do Vale', description: 'Largada do Rally! Lama, troncos, rampas, túneis, morro, pedras e pneus. No ar, aperte F para dar cambalhota (com seta: de lado).', duration: 5500 });
        playTone(110, 0, 0.25, 'sawtooth', 0.07); playTone(165, 0.12, 0.3, 'sawtooth', 0.06); playTone(220, 0.3, 0.25, 'square', 0.05);
      } else {
        showCarSpeech('🚒 Caminhãozinho do Ravi!', 2200);
        setStatusBanner('🚒 Caminhãozinho do Ravi de volta! (Ele atola na lama e não sobe os obstáculos do rally.)', '#ff7a1a');
        notify({ type: 'info', title: 'Caminhãozinho do Ravi', description: 'Mangueira e sirene de volta.', duration: 3000 });
        playTone(440, 0, 0.15, 'triangle', 0.08); playTone(660, 0.1, 0.2, 'triangle', 0.07);
      }
      rumble(0.25, 0.5, 140);
    }
    // Cronômetro da volta do rally (só vale com o Baja e passando pela metade da pista)
    const rallyLap = { active: false, start: 0, half: false, lastT: 0, best: (() => { try { return Number(localStorage.getItem('rallyBestMs')) || 0; } catch (e) { return 0; } })() };
    function updateRallyLap(t, time) {
      const L = rallyLap;
      const crossedStart = L.lastT > 0.9 && t < 0.1;
      if (t > 0.45 && t < 0.6) L.half = true;
      if (crossedStart && currentVehicleType === 'baja') {
        if (L.active && L.half) {
          const ms = Math.round((time - L.start) * 1000);
          const isBest = !L.best || ms < L.best;
          if (isBest) { L.best = ms; try { localStorage.setItem('rallyBestMs', String(ms)); } catch (e) { /* sem storage */ } }
          notify({ type: isBest ? 'success' : 'info', title: isBest ? 'Novo recorde no Rally!' : 'Volta no Rally', description: `${(ms / 1000).toFixed(2)} s${L.best && !isBest ? ` · recorde ${(L.best / 1000).toFixed(2)} s` : ''}`, duration: 4000 });
          sfx('finish', { vol: 0.7, vary: 0 });
          if (isBest) confettiBurst(vehicle.position.x, vehicle.position.y + 3, vehicle.position.z, 60);
        }
        L.active = true; L.start = time; L.half = false;
        setStatusBanner('🏁 Volta do Rally iniciada! Passe por todos os obstáculos.', '#ffb703');
      }
      L.lastT = t;
    }

    // 1. CORPO PRINCIPAL ESCULPIDO PELO PERFIL LATERAL (Com Degrau do Capô Frontal e Curvatura Traseira!)
    // No plano 2D do Shape: x_2d = eixo Z (+ frente, - traseira), y_2d = eixo Y (altura)
    const sideProfile = new THREE.Shape();
    sideProfile.moveTo(-1.52, 0.54);
    sideProfile.lineTo(1.66, 0.54);
    // Frente arredondada do capô inferior (nariz do caminhãozinho)
    sideProfile.quadraticCurveTo(1.84, 0.56, 1.84, 0.82);
    sideProfile.lineTo(1.78, 1.15);
    // Degrau do capô recuando até a base do para-brisa azul (exatamente como na foto lateral!)
    sideProfile.quadraticCurveTo(1.72, 1.35, 1.46, 1.38);
    sideProfile.lineTo(1.36, 1.40);
    // Coluna inclinada do para-brisa subindo até o teto
    sideProfile.lineTo(1.22, 2.12);
    sideProfile.quadraticCurveTo(1.14, 2.35, 0.84, 2.36);
    // Teto levemente arqueado
    sideProfile.lineTo(-1.02, 2.35);
    // Curvatura traseira arredondada
    sideProfile.quadraticCurveTo(-1.42, 2.32, -1.56, 1.98);
    sideProfile.quadraticCurveTo(-1.69, 1.45, -1.66, 0.74);
    sideProfile.quadraticCurveTo(-1.64, 0.54, -1.52, 0.54);

    const mainBodyGeo = new THREE.ExtrudeGeometry(sideProfile, {
      depth: 1.96,
      bevelEnabled: true,
      bevelThickness: 0.25,
      bevelSize: 0.20,
      bevelSegments: 14
    });
    // Centraliza no eixo de extrusão e gira -90° em Y:
    // x_2d -> +Z (frente/traseira), y_2d -> +Y (altura), z_extrude -> X (-1.23 a +1.23)
    mainBodyGeo.translate(0, 0, -0.98);
    mainBodyGeo.rotateY(-Math.PI / 2);

    const mainBodyMesh = new THREE.Mesh(mainBodyGeo, carOrangeMat);
    // Matriz do carrinho lida no instante do desenho (as matrizes já estão atualizadas): pintura presa à carroceria
    mainBodyMesh.onBeforeRender = () => { paintUniforms.uCarInv.value.copy(vehicle.matrixWorld).invert(); };
    mainBodyMesh.castShadow = true;
    mainBodyMesh.receiveShadow = true;
    carBodyGroup.add(mainBodyMesh);

    // 2. SAIA BRANCA INFERIOR + PARALAMAS ARQUEADOS (Wheel Arches sobre as 4 rodas!)
    // Base branca central e para-choques envolventes frontal/traseiro
    const baseSkirtShape = new THREE.Shape();
    const bsw = 1.02, bsl = 1.66, bsr = 0.44;
    baseSkirtShape.moveTo(-bsw + bsr, -bsl); baseSkirtShape.lineTo(bsw - bsr, -bsl);
    baseSkirtShape.quadraticCurveTo(bsw, -bsl, bsw, -bsl + bsr); baseSkirtShape.lineTo(bsw, bsl + 0.14 - bsr);
    baseSkirtShape.quadraticCurveTo(bsw, bsl + 0.14, bsw - bsr, bsl + 0.14); baseSkirtShape.lineTo(-bsw + bsr, bsl + 0.14);
    baseSkirtShape.quadraticCurveTo(-bsw, bsl + 0.14, -bsw, bsl + 0.14 - bsr); baseSkirtShape.lineTo(-bsw, -bsl + bsr);
    baseSkirtShape.quadraticCurveTo(-bsw, -bsl, -bsw + bsr, -bsl);

    const skirtGeo = new THREE.ExtrudeGeometry(baseSkirtShape, {
      depth: 0.26,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.21,
      bevelSegments: 10
    });
    skirtGeo.rotateX(Math.PI / 2);
    const skirtMesh = new THREE.Mesh(skirtGeo, carWhiteSkirtMat);
    skirtMesh.position.set(0, 0.62, 0);
    skirtMesh.castShadow = true;
    carBodyGroup.add(skirtMesh);

    // Os 4 Arcos de Paralama Brancos (Wheel Arches) contornando as rodas + friso lateral branco entre as rodas
    const fenderArchGeo = new THREE.TorusGeometry(0.51, 0.105, 14, 28, Math.PI);
    const wheelWellMat = new THREE.MeshBasicMaterial({ color: 0x101214 });
    const wheelWellGeo = new THREE.CylinderGeometry(0.49, 0.49, 0.16, 24, 1, false, 0, Math.PI);

    [-1, 1].forEach((sideX) => {
      [0.92, -0.92].forEach((wz) => {
        // Arco branco elevado do paralama
        const arch = new THREE.Mesh(fenderArchGeo, carWhiteSkirtMat);
        arch.rotation.y = Math.PI / 2;
        arch.position.set(sideX * 1.18, 0.48, wz);
        carBodyGroup.add(arch);

        // Cavidade escura interna da caixa de roda
        const well = new THREE.Mesh(wheelWellGeo, wheelWellMat);
        well.rotation.z = Math.PI / 2;
        well.rotation.x = -Math.PI / 2;
        well.position.set(sideX * 1.14, 0.48, wz);
        carBodyGroup.add(well);
      });

      // Soleira branca reta conectando o paralama dianteiro ao traseiro
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 0.88), carWhiteSkirtMat);
      sill.position.set(sideX * 1.17, 0.48, 0);
      carBodyGroup.add(sill);
    });

    // 3. PARA-BRISA 3D AZUL-TURQUESA PROTUBERANTE COM ÓCULOS ESCUROS E SORRISINHO
    // Na foto lateral e superior, o para-brisa é uma peça 3D azul translúcida que salta para fora da cabine!
    const visorGroup = new THREE.Group();
    visorGroup.position.set(0, 1.76, 1.50);
    visorGroup.rotation.x = -0.20;

    const visorShape = new THREE.Shape();
    const vw = 0.86, vh = 0.34, vr = 0.14;
    visorShape.moveTo(-vw + vr, -vh); visorShape.lineTo(vw - vr, -vh);
    visorShape.quadraticCurveTo(vw, -vh, vw, -vh + vr); visorShape.lineTo(vw, vh - vr);
    visorShape.quadraticCurveTo(vw, vh, vw - vr, vh); visorShape.lineTo(-vw + vr, vh);
    visorShape.quadraticCurveTo(-vw, vh, -vw, vh - vr); visorShape.lineTo(-vw, -vh + vr);
    visorShape.quadraticCurveTo(-vw, -vh, -vw + vr, -vh);

    const visor3DGeo = new THREE.ExtrudeGeometry(visorShape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 8
    });
    const visor3DMesh = new THREE.Mesh(
      visor3DGeo,
      new THREE.MeshStandardMaterial({ color: 0x169cc2, roughness: 0.12, metalness: 0.08 })
    );
    visorGroup.add(visor3DMesh);

    // Face frontal do para-brisa com os óculos escuros, reflexos brancos e sorrisinho
    const windshieldFace = new THREE.Mesh(
      new THREE.PlaneGeometry(1.68, 0.68),
      new THREE.MeshStandardMaterial({ map: createWindshieldTexture(), roughness: 0.1 })
    );
    windshieldFace.position.set(0, 0, 0.195);
    visorGroup.add(windshieldFace);
    carBodyGroup.add(visorGroup);

    // 4. LATERAIS EM RELEVO 3D REAL: JANELA AMARELA EM ARCO + 3 BARRAS + ESCADA 3D + "//Fire Engine//"
    // Janela lateral amarela com topo arredondado (D-Arch)
    const sideWinShape = new THREE.Shape();
    sideWinShape.moveTo(-0.30, -0.28);
    sideWinShape.lineTo(0.30, -0.28);
    sideWinShape.lineTo(0.30, 0.04);
    sideWinShape.absarc(0, 0.04, 0.30, 0, Math.PI, false);
    sideWinShape.lineTo(-0.30, -0.28);
    const sideWinGeo = new THREE.ExtrudeGeometry(sideWinShape, {
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 5
    });

    const fireEngineLogoTex = createFireEngineLogoTexture();

    [-1, 1].forEach((sideX) => {
      const sideGroup = new THREE.Group();
      sideGroup.position.set(sideX * 1.225, 0, 0);
      sideGroup.rotation.y = sideX > 0 ? Math.PI / 2 : -Math.PI / 2;
      // Quando sideX = +1 (lateral esquerda olhando de frente): +X local do sideGroup aponta para -Z do carro.
      // Para que ambos os lados tenham a janela na frente (+Z) e a escada atrás (-Z), usamos inversão horizontal de coordenadas locais `dir`:
      const dir = sideX > 0 ? -1 : 1;

      // 4a. Janela Amarela em Arco (na frente, z = +0.58)
      const winMesh = new THREE.Mesh(sideWinGeo, sideWindowMat);
      winMesh.position.set(dir * 0.58, 1.66, 0);
      sideGroup.add(winMesh);

      // 4b. As 3 Barras Verticais Amarelas Crescentes ao lado da janela (z = +0.05, -0.19, -0.43)
      const barHeights = [0.38, 0.52, 0.68];
      barHeights.forEach((bh, idx) => {
        const bz = 0.05 - idx * 0.24;
        const barMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.13, bh, 0.05),
          yellowDetailMat
        );
        // Topo arredondado da barrinha amarela
        const barCap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.065, 0.065, 0.05, 12),
          yellowDetailMat
        );
        barCap.rotation.x = Math.PI / 2;
        const baseY = 1.38;
        barMesh.position.set(dir * bz, baseY + bh / 2, 0);
        barCap.position.set(dir * bz, baseY + bh, 0);
        sideGroup.add(barMesh, barCap);
      });

      // 4c. ESCADINHA VERTICAL 3D EM RELEVO LARANJA NA TRASEIRA LATERAL (foto lateral!)
      // Dois trilhos verticais + 3 degraus horizontais em alto-relevo!
      const ladderCenterZ = -0.94;
      [-0.19, 0.19].forEach((railOffset) => {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(0.055, 1.22, 0.08),
          carOrangeMat
        );
        rail.position.set(dir * (ladderCenterZ + railOffset), 1.48, 0.02);
        rail.castShadow = true;
        sideGroup.add(rail);
      });
      // 3 degraus horizontais da escadinha
      [1.22, 1.54, 1.86].forEach((rungY) => {
        const rung = new THREE.Mesh(
          new THREE.BoxGeometry(0.38, 0.055, 0.075),
          carOrangeMat
        );
        rung.position.set(dir * ladderCenterZ, rungY, 0.02);
        sideGroup.add(rung);
      });

      // 4d. Friso Horizontal Moldado na Carroceria (logo acima dos paralamas brancos)
      const grooveLine = new THREE.Mesh(
        new THREE.BoxGeometry(2.75, 0.035, 0.04),
        carOrangeMat
      );
      grooveLine.position.set(dir * 0.05, 0.96, 0.01);
      sideGroup.add(grooveLine);

      // 4e. Logotipo Branco "// Fire Engine //" abaixo da janela e das 3 barras
      const logoPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.52, 0.36),
        new THREE.MeshBasicMaterial({ map: fireEngineLogoTex, transparent: true })
      );
      logoPlane.position.set(dir * 0.18, 1.15, 0.03);
      sideGroup.add(logoPlane);

      carBodyGroup.add(sideGroup);
    });

    // 5. FRENTE DO CAPÔ: GRADE BRANCA COM 3 FRISOS VERMELHOS + FARÓIS OVAIS COM DETALHE INTERNO
    const grilleBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.28, 0.10),
      carWhiteSkirtMat
    );
    grilleBox.position.set(0, 0.80, 2.02);
    carBodyGroup.add(grilleBox);
    for (let i = -1; i <= 1; i++) {
      const slot = new THREE.Mesh(
        new THREE.BoxGeometry(0.56, 0.04, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xff4518 })
      );
      slot.position.set(0, 0.80 + i * 0.075, 2.03);
      carBodyGroup.add(slot);
    }

    // Faróis Ovais Frontais com Aro Branco, Miolo Laranja e Pontinho Branco Lateral (foto frontal!)
    [-0.65, 0.65].forEach((hx) => {
      const hlGroup = new THREE.Group();
      hlGroup.position.set(hx, 0.92, 2.00);
      hlGroup.rotation.y = hx > 0 ? 0.24 : -0.24;
      hlGroup.rotation.x = -0.10;

      const hlOuter = new THREE.Mesh(
        new THREE.CylinderGeometry(0.20, 0.20, 0.08, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      hlOuter.rotation.x = Math.PI / 2;
      hlOuter.scale.set(1.28, 1, 0.76);

      const hlInner = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.10, 16),
        new THREE.MeshBasicMaterial({ color: 0xff4d1a })
      );
      hlInner.rotation.x = Math.PI / 2;
      hlInner.scale.set(1.18, 1, 0.72);
      hlInner.position.x = hx > 0 ? -0.02 : 0.02;

      const hlDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      hlDot.position.set(hx > 0 ? 0.13 : -0.13, 0, 0.05);

      hlGroup.add(hlOuter, hlInner, hlDot);
      carBodyGroup.add(hlGroup);
    });

    // 6. TETO DETALHADO: BOTÃO AMARELO COM DETALHE CENTRAL + DOMO DIVIDIDO DO CANHÃO + 9 FUROS DE SOM!
    // 6a. Botão Redondo Amarelo com Anel Laranja e Marca Central Laranja (foto superior!)
    const roofButtonCollar = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.05, 12, 24),
      carOrangeMat
    );
    roofButtonCollar.rotation.x = Math.PI / 2;
    roofButtonCollar.position.set(0, 2.55, 0.56);
    carBodyGroup.add(roofButtonCollar);

    const yellowRoofButton = new THREE.Group();
    yellowRoofButton.position.set(0, 2.56, 0.56);
    const yellowBtnDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 20, 14),
      yellowDetailMat
    );
    yellowBtnDome.scale.set(1, 0.42, 1);
    // Pequeno ícone laranja no centro do botão amarelo (visível na foto superior!)
    const yellowBtnCenterIcon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.03, 12),
      carOrangeMat
    );
    yellowBtnCenterIcon.position.y = 0.10;
    yellowRoofButton.add(yellowBtnDome, yellowBtnCenterIcon);
    carBodyGroup.add(yellowRoofButton);

    // 6b. Canhão d'água estilo caminhão de bombeiro (monitor de incêndio): base quadrada,
    //     prato giratório metálico, garfo vermelho, cano de aço inclinado e bico amarelo.
    const turretGroup = new THREE.Group();
    turretGroup.position.set(0, 2.54, -0.22);
    const cannonSteelMat = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.75, roughness: 0.28 });
    const cannonRedMat = new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.45 });
    const cannonDarkMat = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.6 });

    const cannonBase = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.08, 0.74), cannonDarkMat);
    cannonBase.position.y = 0.04;
    const cannonTurntable = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.12, 6), cannonSteelMat);
    cannonTurntable.position.y = 0.14;
    turretGroup.add(cannonBase, cannonTurntable);

    // Garfo (duas chapas laterais retas) segurando o eixo do cano
    [-0.17, 0.17].forEach((dx) => {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.26), cannonRedMat);
      plate.position.set(dx, 0.36, 0);
      plate.castShadow = true;
      turretGroup.add(plate);
    });
    const cannonAxle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.44, 10), cannonSteelMat);
    cannonAxle.rotation.z = Math.PI / 2;
    cannonAxle.position.set(0, 0.44, 0);
    turretGroup.add(cannonAxle);

    // Cano inclinado ~20° para cima, apontando para a frente
    const cannonPitch = new THREE.Group();
    cannonPitch.position.set(0, 0.44, 0);
    cannonPitch.rotation.x = -0.35;
    const nozzleTube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.9, 12), cannonSteelMat);
    nozzleTube.rotation.x = Math.PI / 2;
    nozzleTube.position.set(0, 0, 0.32);
    nozzleTube.castShadow = true;
    const cannonClamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.16), cannonRedMat);
    cannonClamp.position.set(0, 0, 0);
    // Bico de jato em leque (abre para a ponta) + alça de mira em cima
    const nozzleTip = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.08, 0.24, 6), yellowDetailMat);
    nozzleTip.rotation.x = Math.PI / 2;
    nozzleTip.position.set(0, 0, 0.88);
    const cannonHandle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.36), cannonDarkMat);
    cannonHandle.position.set(0, 0.13, 0.22);
    const handlePostA = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), cannonDarkMat);
    handlePostA.position.set(0, 0.08, 0.08);
    const handlePostB = handlePostA.clone();
    handlePostB.position.z = 0.36;
    cannonPitch.add(nozzleTube, cannonClamp, nozzleTip, cannonHandle, handlePostA, handlePostB);
    turretGroup.add(cannonPitch);
    carBodyGroup.add(turretGroup);

    // 6c. Os 9 Furos Circulares do Alto-Falante no Teto Traseiro (nivelados na superfície atrás do canhão!)
    const speakerCenterZ = -0.96;
    const holeGeo = new THREE.CircleGeometry(0.052, 16);
    function addSpeakerHole(hx, hz) {
      const hole = new THREE.Mesh(holeGeo, speakerHoleMat);
      // Segue exatamente a curvatura transversal (hx) e longitudinal (hz) do teto!
      const dropZ = hz < -1.00 ? Math.pow(-1.00 - hz, 2) * 0.35 : 0;
      const dropX = Math.pow(hx, 2) * 0.05;
      hole.position.set(hx, 2.564 - dropZ - dropX, hz);
      hole.rotation.x = -Math.PI / 2 - (hz < -1.00 ? (-1.00 - hz) * 0.38 : 0);
      carBodyGroup.add(hole);
    }
    // Furo central + 8 furos ao redor (entre z = -0.78 e z = -1.14, 100% livres atrás do domo!)
    addSpeakerHole(0, speakerCenterZ);
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      addSpeakerHole(Math.cos(ang) * 0.40, speakerCenterZ + Math.sin(ang) * 0.18);
    }

    // 7. TRASEIRA COMPLETA: JANELA TRASEIRA AMARELA GRANDE + GRADE TRASEIRA + LANTERNAS (foto traseira!)
    // Janela amarela traseira com cantos arredondados
    const rearWinShape = new THREE.Shape();
    const rww = 0.72, rwh = 0.32, rwr = 0.12;
    rearWinShape.moveTo(-rww + rwr, -rwh); rearWinShape.lineTo(rww - rwr, -rwh);
    rearWinShape.quadraticCurveTo(rww, -rwh, rww, -rwh + rwr); rearWinShape.lineTo(rww - 0.05, rwh - rwr);
    rearWinShape.quadraticCurveTo(rww - 0.05, rwh, rww - 0.05 - rwr, rwh); rearWinShape.lineTo(-rww + 0.05 + rwr, rwh);
    rearWinShape.quadraticCurveTo(-rww + 0.05, rwh, -rww + 0.05, rwh - rwr); rearWinShape.lineTo(-rww, -rwh + rwr);
    rearWinShape.quadraticCurveTo(-rww, -rwh, -rww + rwr, -rwh);

    const rearWinGeo = new THREE.ExtrudeGeometry(rearWinShape, {
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 5
    });
    const rearWindowMesh = new THREE.Mesh(rearWinGeo, yellowDetailMat);
    rearWindowMesh.rotation.y = Math.PI;
    rearWindowMesh.rotation.x = 0.12;
    rearWindowMesh.position.set(0, 1.54, -1.85);
    carBodyGroup.add(rearWindowMesh);

    // Grade Traseira Branca Central com 3 Frisos Vermelhos
    const rearGrille = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.24, 0.08), carWhiteSkirtMat);
    rearGrille.position.set(0, 0.80, -1.88);
    carBodyGroup.add(rearGrille);
    for (let i = -1; i <= 1; i++) {
      const rSlot = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.035, 0.10),
        new THREE.MeshBasicMaterial({ color: 0xff4518 })
      );
      rSlot.position.set(0, 0.80 + i * 0.065, -1.89);
      carBodyGroup.add(rSlot);
    }

    // Lanternas Traseiras Brancas com Friso Vermelho/Laranja Interno
    [-0.63, 0.63].forEach((rx) => {
      const tailOuter = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, 0.19, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      tailOuter.position.set(rx, 0.84, -1.86);
      tailOuter.rotation.y = rx > 0 ? -0.20 : 0.20;

      const tailInner = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.08, 0.10),
        new THREE.MeshBasicMaterial({ color: 0xff4518 })
      );
      tailInner.position.set(rx, 0.84, -1.87);
      tailInner.rotation.y = rx > 0 ? -0.20 : 0.20;
      carBodyGroup.add(tailOuter, tailInner);
    });

    // 8. AS 4 RODAS PRETAS LARGAS COM CALOTAS ABAULADAS AZUL-TURQUESA (CIANO)
    // Rodas no estilo off-road do mundo do DS: pneus grandes e grossos com cravos, aro escuro e calota ciano
    const wheelPositions = [
      [-1.18, 0.56, 0.95],
      [1.18, 0.56, 0.95],
      [-1.18, 0.56, -0.95],
      [1.18, 0.56, -0.95]
    ];
    const tireChunkyMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.8, flatShading: true });
    const rimDarkMat = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.45, metalness: 0.3, flatShading: true });
    const treadGeo = new THREE.BoxGeometry(0.46, 0.12, 0.16);
    const wheels = [];
    wheelPositions.forEach((pos) => {
      const wGroup = new THREE.Group();
      wGroup.position.set(...pos);
      const side = pos[0] > 0 ? 1 : -1;

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.44, 14), tireChunkyMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wGroup.add(tire);
      // Cravos do pneu
      // Cravos instanciados: 1 chamada de desenho por roda (antes 14 malhas)
      const knobs = new THREE.InstancedMesh(treadGeo, tireChunkyMat, 14);
      const _kn = new THREE.Object3D();
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        _kn.position.set(0, Math.cos(a) * 0.53, Math.sin(a) * 0.53);
        _kn.rotation.set(-a, 0, 0);
        _kn.updateMatrix();
        knobs.setMatrixAt(i, _kn.matrix);
      }
      knobs.castShadow = true;
      wGroup.add(knobs);
      const rimDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.46, 8), rimDarkMat);
      rimDisc.rotation.z = Math.PI / 2;
      wGroup.add(rimDisc);
      // Calota ciano (identidade do caminhãozinho do Ravi)
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.08, 8), cyanWheelMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.x = side * 0.25;
      wGroup.add(rim);

      vehicle.add(wGroup);
      wheels.push(wGroup);
    });

    // Para-choques pretos robustos (frente com "dentes" e traseira)
    const bumperMat = new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.6, flatShading: true });
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.3, 0.34), bumperMat);
    frontBumper.position.set(0, 0.5, 2.12);
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.28, 0.3), bumperMat);
    rearBumper.position.set(0, 0.5, -2.0);
    [-0.75, 0.75].forEach((bx) => {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.22), bumperMat);
      tooth.position.set(bx, 0.62, 2.22);
      carBodyGroup.add(tooth);
    });
    carBodyGroup.add(frontBumper, rearBumper);

    // Barra de sirene no teto (vermelho/azul piscando) — luzes de teto como no carro do mundo do DS
    const sirenBase = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.34), bumperMat);
    sirenBase.position.set(0, 2.6, 1.18);
    const sirenRedMat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 0.6, roughness: 0.3 });
    const sirenBlueMat = new THREE.MeshStandardMaterial({ color: 0x2a7bff, emissive: 0x2a7bff, emissiveIntensity: 0.6, roughness: 0.3 });
    const sirenRed = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.28), sirenRedMat);
    sirenRed.position.set(-0.36, 2.76, 1.18);
    const sirenBlue = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.28), sirenBlueMat);
    sirenBlue.position.set(0.36, 2.76, 1.18);
    carBodyGroup.add(sirenBase, sirenRed, sirenBlue);
    // Sirene (luz + som) só com o jato d'água ligado; parada, as lentes ficam apagadas
    function updateSiren(time) {
      const spraying = keys.spray && !inputBlocked() && totalWater() > 0 && currentVehicleType !== 'baja';
      setSirenSound(spraying);
      if (!spraying) {
        sirenRedMat.emissiveIntensity = 0.12;
        sirenBlueMat.emissiveIntensity = 0.12;
        return;
      }
      const phase = Math.floor(time * 7) % 2;
      sirenRedMat.emissiveIntensity = phase ? 1.6 : 0.15;
      sirenBlueMat.emissiveIntensity = phase ? 0.15 : 1.6;
    }

    vehicle.position.set(11.5, 0.14, 11.5);
    vehicle.rotation.order = 'YXZ'; // guinada por fora: inclinação/rolagem ficam no referencial do carrinho
    vehicle.rotation.y = -0.55;
    scene.add(vehicle);

    vehicle.rotation.order = 'YXZ'; // yaw primeiro, depois inclinação do terreno (rampa) em coordenadas locais

    // ============================================================================
    // UI — DESIGN SYSTEM BRUNO SIMON (intro, menu, mapa, notificações, conquistas)
    // ============================================================================
    const htmlEl = document.documentElement;
    const eventLogListEl = document.getElementById('event-log-list');
    const speechBubbleEl = document.getElementById('car-speech-bubble');
    const grabBtnEl = document.getElementById('t-grab');
    const grabLabelEl = document.getElementById('t-grab-label');
    const hudWaterEl = document.getElementById('hud-water');
    const waterPctEl = document.getElementById('water-pct');
    const waterBarEl = document.getElementById('water-bar-fill');
    const statusBannerEl = document.getElementById('status-banner');
    const fireAlertEl = document.getElementById('fire-alert');
    const fireTimerEl = document.getElementById('fire-timer');
    const fireTimeBarEl = document.getElementById('fire-time-bar');

    // Modo de entrada (touch x mouse/teclado) — o DS alterna estilos por classe no <html>
    function setInputMode(touch) {
      htmlEl.classList.toggle('is-mode-touch', touch);
      htmlEl.classList.toggle('is-mode-mouse-keyboard', !touch);
    }
    setInputMode(window.matchMedia('(pointer: coarse)').matches);
    window.addEventListener('touchstart', () => setInputMode(true), { passive: true });
    window.addEventListener('keydown', () => { if (htmlEl.classList.contains('is-mode-touch')) setInputMode(false); });

    let introActive = true;
    let menuOpen = false;
    let modalsOpen = null;     // 'map' | 'reset' | null
    let isModalOpen = false;   // jogo pausado aguardando reinício
    let modalRequiresReset = false;

    function inputBlocked() {
      // Durante a decolagem do foguete o carrinho espera (câmera exclusiva do lançamento)
      return introActive || menuOpen || !!modalsOpen || isModalOpen || raceState === 'countdown' ||
        !!rocketLaunch;
    }

    // ---------- Notificações (toasts .notifications .notification) ----------
    const notificationItemsEl = document.getElementById('notification-items');
    const activeNotifications = new Map();

    function notify({ type = 'info', title, description = '', progress = '', duration = 3800, key }) {
      key = key || type + ':' + title;
      let n = activeNotifications.get(key);
      if (!n) {
        const el = document.createElement('div');
        el.className = `notification is-${type}`;
        el.innerHTML =
          '<div class="time-bar"></div>' +
          '<div class="top"><div class="title"></div>' +
          (type === 'achievement' ? '<div class="progress"><span class="check-icon"></span><span class="progress-text"></span></div>' : '') +
          (type === 'music' ? '<span class="music-note-icon"></span>' : '') +
          '</div><div class="bottom"><p class="description"></p></div>';
        el.addEventListener('click', () => dismissNotification(key));
        notificationItemsEl.appendChild(el);
        n = { el, bar: el.querySelector('.time-bar') };
        activeNotifications.set(key, n);
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-visible')));
        while (activeNotifications.size > 4) dismissNotification(activeNotifications.keys().next().value);
      }
      n.el.querySelector('.title').textContent = title;
      const descEl = n.el.querySelector('.description');
      descEl.textContent = description;
      descEl.parentElement.style.display = description ? '' : 'none';
      const progEl = n.el.querySelector('.progress-text');
      if (progEl) progEl.textContent = progress;
      n.start = performance.now();
      n.duration = duration;
      clearTimeout(n.timer);
      n.timer = setTimeout(() => dismissNotification(key), duration);
    }

    function dismissNotification(key) {
      const n = activeNotifications.get(key);
      if (!n) return;
      activeNotifications.delete(key);
      clearTimeout(n.timer);
      n.el.classList.remove('is-visible');
      n.el.classList.add('is-leaving');
      setTimeout(() => n.el.remove(), 460);
    }

    function updateNotificationBars(now) {
      activeNotifications.forEach((n) => {
        const k = clamp(1 - (now - n.start) / n.duration, 0, 1);
        n.bar.style.transform = `scaleX(${k})`;
      });
    }

    // ---------- Log de eventos (menu > Bastidores) ----------
    let lastLoggedMsg = '';
    function logInteractionEvent(msg) {
      if (msg === lastLoggedMsg) return;
      lastLoggedMsg = msg;
      const ts = new Date().toTimeString().slice(0, 8);
      const li = document.createElement('li');
      li.textContent = `[${ts}] ${msg}`;
      eventLogListEl.prepend(li);
      while (eventLogListEl.children.length > 40) eventLogListEl.removeChild(eventLogListEl.lastChild);
    }

    // ---------- Status do HUD (cores semânticas do DS) ----------
    function toneFromColor(color) {
      const c = (color || '').toLowerCase();
      if (['#7ee787', '#69f0ae', '#a5d6a7'].includes(c)) return 'is-success';
      if (['#ff5252', '#f44336', '#ff5722'].includes(c)) return 'is-danger';
      if (['#35e0ff', '#00e5ff'].includes(c)) return 'is-peach';
      if (['#ffb300'].includes(c)) return 'is-music';
      return '';
    }
    function setStatusBanner(msg, color = '') {
      if (statusBannerEl.textContent === msg) return;
      statusBannerEl.textContent = msg;
      statusBannerEl.className = 'status ' + toneFromColor(color);
    }

    // ---------- Balão de fala ----------
    let speechTimeout = null;
    let isSpeechActive = false;
    let breakSpeechToggle = false;
    let accelContinuousTime = 0;
    let lastVrumSpeechTime = -10;
    let lastPlantSpeechTime = -10;

    function showCarSpeech(text, durationMs = 2600) {
      speechBubbleEl.textContent = text;
      speechBubbleEl.style.display = 'block';
      isSpeechActive = true;
      if (speechTimeout) clearTimeout(speechTimeout);
      speechTimeout = setTimeout(() => {
        speechBubbleEl.style.display = 'none';
        isSpeechActive = false;
      }, durationMs);
    }

    const speechAnchor = new THREE.Vector3();
    function updateSpeechBubblePosition() {
      if (!isSpeechActive) return;
      speechAnchor.copy(vehicle.position);
      speechAnchor.y += 3.6;
      speechAnchor.project(camera);
      if (speechAnchor.z > 1) {
        speechBubbleEl.style.visibility = 'hidden';
        return;
      }
      speechBubbleEl.style.visibility = '';
      speechBubbleEl.style.left = `${(speechAnchor.x * 0.5 + 0.5) * sizes.width}px`;
      speechBubbleEl.style.top = `${(-(speechAnchor.y * 0.5) + 0.5) * sizes.height}px`;
    }

    // ---------- Conquistas + pinturas (Data Display do DS) ----------
    const ACHIEVEMENTS = [
      { id: 'firefighter', title: 'Bombeiro mirim', description: 'Apague o incêndio do monitor', total: 1 },
      { id: 'oops', title: 'Ops!', description: "Derrube o copo d'água", total: 1 },
      { id: 'gardener', title: 'Jardineiro', description: 'Regue as 3 plantas da mesa', total: 3 },
      { id: 'turbo', title: 'Caçador de pilhas', description: 'Encontre as 15 pilhas palito (algumas estão escondidas!)', total: 15 },
      { id: 'artist', title: 'Artista', description: 'Rabisque a mesa com o lápis de cor', total: 1 },
      { id: 'racer', title: 'Piloto', description: 'Complete uma volta no circuito', total: 1 },
      { id: 'speedster', title: 'Relâmpago', description: 'Faça uma volta em menos de 1min15s', total: 1 },
      { id: 'islands', title: 'Navegador', description: 'Visite as 5 ilhas do quarto', total: 5 },
      { id: 'islandActions', title: 'Aventureiro', description: 'Faça 5 atividades nas ilhas', total: 5 },
      { id: 'bowling', title: 'Strike!', description: 'Derrube os 10 pinos do boliche', total: 1 },
      { id: 'shortcut', title: 'Atalho secreto', description: 'Salte da rampa escondida embaixo da mesa', total: 1 },
      { id: 'career', title: 'Linha do tempo', description: 'Visite os 6 marcos de carreira nos portais da pista', total: 6 },
      // Secretas: nome e descrição ficam escondidos ("???") até serem desbloqueadas
      { id: 'ballDesk', title: 'Bola de mesa', description: 'Leve uma bola do quarto, pela rampa, até a mesa perto do aquário', total: 1, secret: true },
      { id: 'allIslands', title: 'Explorador das ilhas', description: 'Visite e interaja com todas as ilhas do quarto', total: islands.length, secret: true },
      { id: 'coins', title: 'Cofrinho do Ravi', description: 'Junte as 40 moedas espalhadas pela mesa, pelo quarto e pelo rally', total: 40 },
      { id: 'rainbowTrack', title: 'Pista mágica', description: 'Pinte a pista inteira com o lápis de cor (mesa, rampas e chão)', total: 100, secret: true },
      { id: 'nitro', title: 'Nitro!', description: 'Sobrecarregue a bateria acima de 120%', total: 1 },
      { id: 'kaboom', title: 'Sobrecarga', description: 'Passe de 140% de bateria e exploda (sem quebrar o carrinho)', total: 1 },
      { id: 'crates', title: 'Surpresa!', description: 'Exploda 5 caixas-surpresa', total: 5 },
      { id: 'skydiver', title: 'Paraquedista', description: 'Caia da mesa até o chão do quarto', total: 1 },
      { id: 'slide', title: 'Tobogã', description: 'Desça pela rampa de papelão', total: 1 },
      { id: 'acrobat', title: 'Acrobata', description: 'Capote o carrinho', total: 1 },
      { id: 'destroyer', title: 'Destruidor', description: 'Quebre um controle por completo', total: 1 },
      { id: 'jumper', title: 'Pula-pula', description: 'Pule 10 vezes', total: 10 },
      { id: 'traveler', title: 'Explorador', description: 'Viaje usando o mapa', total: 1 }
    ];
    const REWARDS = [
      { id: 'orange', label: 'Laranja', image: 'orange', unlockAt: 0, color: 0xff4518 },
      { id: 'red', label: 'Vermelho', image: 'red', unlockAt: 2, color: 0xd61f1f },
      { id: 'white', label: 'Branco', image: 'white', unlockAt: 4, color: 0xf2f2f2 },
      { id: 'black', label: 'Preto', image: 'black', unlockAt: 6, color: 0x222326 },
      { id: 'flames', label: 'Chamas', image: 'flames', unlockAt: 9, color: 0xff7b00, emissive: 0x611500 },
      { id: 'abyssal', label: 'Abissal', image: 'abyssal', unlockAt: 13, color: 0x3a1a6b, emissive: 0x1a0533 }
    ];
    const ACH_STORAGE_KEY = 'fire_engine_achievements_v1';
    let achievementState = { progress: {}, unlocked: {}, sets: {}, paint: 'orange' };
    try {
      const raw = localStorage.getItem(ACH_STORAGE_KEY);
      if (raw) achievementState = Object.assign(achievementState, JSON.parse(raw));
    } catch (e) { /* storage indisponível: segue em memória */ }
    syncBatteriesWithSavedState();

    function saveAchievements() {
      try { localStorage.setItem(ACH_STORAGE_KEY, JSON.stringify(achievementState)); } catch (e) { /* ignora */ }
      try { scheduleCloudSave(); } catch (e) { /* nuvem ainda não inicializada */ }
    }
    function unlockedCount() { return ACHIEVEMENTS.filter(a => achievementState.unlocked[a.id]).length; }

    function progressAchievement(id, value = 1, absolute = false) {
      const a = ACHIEVEMENTS.find(x => x.id === id);
      if (!a || achievementState.unlocked[id]) return;
      const before = achievementState.progress[id] || 0;
      const now = Math.min(a.total, absolute ? value : before + value);
      if (now === before) return;
      achievementState.progress[id] = now;
      if (now >= a.total) {
        const prevCount = unlockedCount();
        achievementState.unlocked[id] = Date.now();
        notify({ type: 'achievement', title: a.title, description: a.description, progress: `${now} / ${a.total}`, duration: 5000 });
        sfx('achievement', { vol: 0.65, vary: 0 });
        logInteractionEvent(`🏅 Conquista desbloqueada: ${a.title}`);
        const newCount = unlockedCount();
        REWARDS.forEach((r) => {
          if (r.unlockAt > prevCount && r.unlockAt <= newCount) {
            notify({ type: 'success', title: 'Nova pintura!', description: `${r.label} liberada em Conquistas`, duration: 5000 });
            sfx('reward', { vol: 0.6, delay: 0.3, vary: 0 });
          }
        });
      }
      saveAchievements();
      if (menuOpen) renderAchievements();
      if (typeof drawNotebooks === 'function') drawNotebooks();
    }
    function unlockAchievement(id) {
      const a = ACHIEVEMENTS.find(x => x.id === id);
      if (a) progressAchievement(id, a.total, true);
    }
    function trackAchievementSet(id, member) {
      const set = achievementState.sets[id] || (achievementState.sets[id] = []);
      if (set.includes(member)) return;
      set.push(member);
      progressAchievement(id, set.length, true);
    }

    // Pintura da carroceria: recompensas (Chamas e Abissal usam o shader) ou cor personalizada da Ilha das Cores
    const PAINT_MODES = { flames: 1, abyssal: 2 };
    function applyPaint(id) {
      if (id === 'custom' && achievementState.custom && achievementState.custom.body) {
        carOrangeMat.color.set(achievementState.custom.body);
        carOrangeMat.emissive.setHex(0x000000);
        paintUniforms.uPaintMode.value = 0;
        achievementState.paint = 'custom';
      } else {
        const r = REWARDS.find(x => x.id === id) || REWARDS[0];
        carOrangeMat.color.setHex(r.color);
        carOrangeMat.emissive.setHex(0x000000);
        paintUniforms.uPaintMode.value = PAINT_MODES[r.id] || 0;
        achievementState.paint = r.id;
      }
      saveAchievements();
    }
    // Rodas, pneus e vidros personalizados (cores padrão quando não escolhidas)
    const CAR_PART_DEFAULTS = { wheels: '#38d9e8', tires: '#1b1e23', glass: '#169cc2' };
    function applyCarCustom() {
      const c = achievementState.custom || {};
      const wheels = new THREE.Color(c.wheels || CAR_PART_DEFAULTS.wheels);
      cyanWheelMat.color.copy(wheels);
      rimDarkMat.color.copy(wheels).lerp(new THREE.Color(0x111111), 0.65);
      const tires = new THREE.Color(c.tires || CAR_PART_DEFAULTS.tires);
      tireChunkyMat.color.copy(tires);
      tireDarkMat.color.copy(tires).multiplyScalar(0.85);
      visor3DMesh.material.color.set(c.glass || CAR_PART_DEFAULTS.glass);
      // As janelas laterais acompanham o vidro escolhido (amarelas no padrão do caminhãozinho)
      sideWindowMat.color.set(c.glass || '#ffcf48');
    }

    const achItemsEl = document.getElementById('ach-items');
    const achRewardsEl = document.getElementById('ach-rewards');
    function renderAchievements() {
      const count = unlockedCount();
      document.getElementById('ach-current').textContent = count;
      document.getElementById('ach-total').textContent = ACHIEVEMENTS.length;
      document.getElementById('ach-global').classList.toggle('is-achieved', count === ACHIEVEMENTS.length);
      achItemsEl.innerHTML = '';
      ACHIEVEMENTS.forEach((a) => {
        const done = !!achievementState.unlocked[a.id];
        const prog = done ? a.total : (achievementState.progress[a.id] || 0);
        const el = document.createElement('div');
        el.className = 'achievement' + (done ? ' is-achieved' : '');
        el.innerHTML = `<div class="title"></div><div class="description"><p class="text"></p><div class="progress"><span class="check-icon"></span><span>${prog} / ${a.total}</span></div></div><div class="bar"><div class="fill" style="transform:scaleX(${prog / a.total})"></div></div>`;
        const hidden = a.secret && !done;
        el.querySelector('.title').textContent = hidden ? '??? Conquista secreta' : a.title;
        el.querySelector('.text').textContent = hidden ? 'Explore o mundo para descobrir…' : a.description;
        if (hidden) el.classList.add('is-secret');
        achItemsEl.appendChild(el);
      });
      achRewardsEl.innerHTML = '';
      REWARDS.forEach((r) => {
        const locked = count < r.unlockAt;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reward has-tooltip' + (locked ? ' is-locked' : '') + (achievementState.paint === r.id ? ' is-active' : '');
        btn.innerHTML = `<div class="tooltip">${locked ? `Desbloqueie com <strong>${r.unlockAt}</strong> conquistas` : r.label}</div><img class="picture" src="./assets/ui/achievements/rewards/${r.image}.webp" alt="${r.label}"><div class="lock"><img class="lock-icon" src="./assets/ui/lock.svg" alt=""></div>`;
        btn.addEventListener('click', () => {
          if (locked) return;
          applyPaint(r.id);
          renderAchievements();
          notify({ type: 'info', title: `Pintura ${r.label}`, duration: 2200 });
        });
        achRewardsEl.appendChild(btn);
      });
    }
    document.getElementById('ach-reset').addEventListener('click', () => {
      achievementState = { progress: {}, unlocked: {}, sets: {}, paint: 'orange' };
      saveAchievements();
      applyPaint('orange');
      renderAchievements();
      drawNotebooks();
      notify({ type: 'danger', title: 'Conquistas zeradas', duration: 2600 });
    });
    applyPaint(achievementState.paint);
    applyCarCustom();
    restoreTrackPaint();

    // ---------- Ilha das Cores: loja de pintura (prévia ao vivo no carrinho) ----------
    const PAINT_PALETTE = ['#ff4518', '#e63946', '#b5179e', '#ff8fab', '#8338ec', '#3a86ff', '#38d9e8', '#2a9d8f',
      '#7ee787', '#ffcf48', '#fb8500', '#8d5524', '#f2f2f2', '#9aa0a6', '#222326', '#0b0b0d'];
    let paintPart = 'body';
    const paintSwatchesEl = document.getElementById('paint-swatches');
    const paintSpecialsEl = document.getElementById('paint-specials');
    function currentPartColor(part) {
      const c = achievementState.custom || {};
      if (part === 'body') return achievementState.paint === 'custom' ? c.body : (REWARDS.find(r => r.id === achievementState.paint) ? '#' + REWARDS.find(r => r.id === achievementState.paint).color.toString(16).padStart(6, '0') : null);
      return c[part] || CAR_PART_DEFAULTS[part];
    }
    function renderPaintShop() {
      // Se o foco (teclado/controle) estava numa cor, lembra qual para manter depois de redesenhar
      const prevSwatch = uiFocusEl && uiFocusEl.classList.contains('paint-swatch') ? [...paintSwatchesEl.children].indexOf(uiFocusEl) : -1;
      const prevSpecial = uiFocusEl && uiFocusEl.classList.contains('paint-special') ? [...paintSpecialsEl.children].indexOf(uiFocusEl) : -1;
      document.querySelectorAll('#paint-tabs .button').forEach(b => b.classList.toggle('is-active', b.dataset.part === paintPart));
      const active = (currentPartColor(paintPart) || '').toLowerCase();
      paintSwatchesEl.innerHTML = '';
      PAINT_PALETTE.forEach((hex) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'paint-swatch' + (hex === active && !(paintPart === 'body' && PAINT_MODES[achievementState.paint]) ? ' is-active' : '');
        b.style.background = hex;
        b.setAttribute('aria-label', `Cor ${hex}`);
        b.addEventListener('click', () => setPartColor(paintPart, hex));
        paintSwatchesEl.appendChild(b);
      });
      // Acabamentos especiais (conquistas) só para a carroceria
      paintSpecialsEl.innerHTML = '';
      if (paintPart === 'body') {
        const count = unlockedCount();
        REWARDS.filter(r => PAINT_MODES[r.id]).forEach((r) => {
          const locked = count < r.unlockAt;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'paint-special' + (locked ? ' is-locked' : '') + (achievementState.paint === r.id ? ' is-active' : '');
          b.innerHTML = `<img src="./assets/ui/achievements/rewards/${r.image}.webp" alt=""><span></span>`;
          b.querySelector('span').textContent = locked ? `${r.label} (${r.unlockAt} conquistas)` : r.label;
          b.addEventListener('click', () => { if (locked) return; applyPaint(r.id); renderPaintShop(); playTone(880, 0, 0.08, 'triangle', 0.05); });
          paintSpecialsEl.appendChild(b);
        });
      }
      if (modalsOpen === 'paint') {
        if (prevSwatch >= 0) focusUiElement(paintSwatchesEl.children[prevSwatch]);
        else if (prevSpecial >= 0 && paintSpecialsEl.children[prevSpecial]) focusUiElement(paintSpecialsEl.children[prevSpecial]);
      }
    }
    function setPartColor(part, hex) {
      achievementState.custom = Object.assign({}, achievementState.custom || {}, { [part]: hex });
      if (part === 'body') applyPaint('custom'); else { applyCarCustom(); saveAchievements(); }
      renderPaintShop();
      playTone(520 + PAINT_PALETTE.indexOf(hex) * 30, 0, 0.07, 'triangle', 0.05);
    }
    function openPaintShop() {
      paintPart = 'body';
      renderPaintShop();
      openModalPanel('paint');
      // Já abre com a cor atual selecionada: setas/D-pad navegam e Enter/✕ escolhem
      focusUiElement(paintSwatchesEl.querySelector('.is-active') || paintSwatchesEl.firstElementChild);
      // Câmera mostra o carrinho de perto para ver a prévia das cores
      setCameraMode('close');
    }
    document.querySelectorAll('#paint-tabs .button').forEach((b) => b.addEventListener('click', () => { paintPart = b.dataset.part; renderPaintShop(); }));
    document.getElementById('paint-reset').addEventListener('click', () => {
      achievementState.custom = {};
      applyPaint('orange');
      applyCarCustom();
      renderPaintShop();
      notify({ type: 'info', title: 'Cores originais', description: 'O caminhãozinho voltou ao laranja de fábrica.', duration: 2500 });
    });
    document.getElementById('paint-done').addEventListener('click', () => { closeModals(); showCarSpeech('Ficou lindo! 🎨', 2000); });
    document.getElementById('paint-close').addEventListener('click', closeModals);

    // ---------- Menu split-pane ----------
    const menuEl = document.getElementById('menu');
    const menuNavItems = [...document.querySelectorAll('#menu-navigation .item')];
    const menuPreviews = [...document.querySelectorAll('#menu-previews .preview')];
    const menuContents = [...document.querySelectorAll('#menu-contents .content')];
    let currentMenuSection = 'home';

    function selectMenuSection(name) {
      currentMenuSection = name;
      menuNavItems.forEach(el => el.classList.toggle('is-active', el.dataset.name === name));
      menuPreviews.forEach(el => el.classList.toggle('is-visible', el.dataset.name === name));
      menuContents.forEach(el => el.classList.toggle('is-visible', el.dataset.name === name));
      if (name === 'achievements') renderAchievements();
      if (name === 'home') renderGarage();
      if (name === 'worlds') renderWorlds();
      if (name === 'circuit') renderRecords();
      sfx('uiMove', { vol: 0.3 });
    }
    menuNavItems.forEach(el => el.addEventListener('click', () => selectMenuSection(el.dataset.name)));

    // Previews do menu: fotos instantâneas da própria cena 3D
    const snapCamera = new THREE.PerspectiveCamera(34, 1, 0.5, 450);
    function captureView(pos, target) {
      snapCamera.aspect = sizes.width / sizes.height;
      snapCamera.updateProjectionMatrix();
      snapCamera.position.copy(pos);
      snapCamera.lookAt(target);
      const tcVisible = transformControl.visible;
      transformControl.visible = false;
      renderer.render(scene, snapCamera);
      transformControl.visible = tcVisible;
      return renderer.domElement.toDataURL('image/jpeg', 0.82);
    }
    function refreshMenuPreviews() {
      const car = vehicle.position;
      const views = IS_QUINTAL ? {
        home: [new THREE.Vector3(car.x + 9, car.y + 6, car.z + 11), new THREE.Vector3(car.x, car.y + 1, car.z)],
        worlds: [new THREE.Vector3(230, 90, -110), new THREE.Vector3(230, -36, 10)],
        circuit: [new THREE.Vector3(200, -14, -40), new THREE.Vector3(240, -34, 0)],
        achievements: [new THREE.Vector3(160, -24, -25), new THREE.Vector3(145, -34, -55)],
        about: [new THREE.Vector3(152, -26, 32), new THREE.Vector3(134, -34, 46)],
        controls: [new THREE.Vector3(car.x + 6, car.y + 4.5, car.z + 8), new THREE.Vector3(car.x, car.y + 1.2, car.z)],
        options: [new THREE.Vector3(300, 40, 90), new THREE.Vector3(230, -36, 0)],
        behindTheScene: [new THREE.Vector3(170, -20, 60), new THREE.Vector3(152, -34, 70)]
      } : {
        worlds: [new THREE.Vector3(200, -8, -10), new THREE.Vector3(237, -26, 30)],
        about: [new THREE.Vector3(14, 16, 26), new THREE.Vector3(2, 8, -12)],
        home: [new THREE.Vector3(48, 40, 70), new THREE.Vector3(0, 0, 6)],
        options: [new THREE.Vector3(88, 56, 133), new THREE.Vector3(0, -18, 15)],
        controls: [new THREE.Vector3(car.x + 6, car.y + 4.5, car.z + 8), new THREE.Vector3(car.x, car.y + 1.2, car.z)],
        achievements: [new THREE.Vector3(58, 16, 24), new THREE.Vector3(80, 4, -4)],
        behindTheScene: [new THREE.Vector3(-62, 12, 78), new THREE.Vector3(-112, -18, 28)],
        circuit: [new THREE.Vector3(30, -16, 70), new THREE.Vector3(0, -34, 20)]
      };
      menuPreviews.forEach((pv) => {
        const v = views[pv.dataset.name];
        if (v) pv.querySelector('.background').src = captureView(v[0], v[1]);
      });
    }

    function openMenu(section) {
      sfx('uiOpen', { vol: 0.45 });
      if (introActive || isModalOpen) return;
      if (modalsOpen) closeModals();
      releaseAllKeys();
      selectMenuSection(section || currentMenuSection);
      refreshMenuPreviews();
      if (currentMenuSection === 'achievements') renderAchievements();
      menuOpen = true;
      menuEl.setAttribute('aria-hidden', 'false');
      menuEl.classList.add('is-displayed');
      htmlEl.classList.add('input-filter-menu');
      requestAnimationFrame(() => menuEl.classList.add('is-visible'));
    }
    function closeMenu() {
      sfx('uiClose', { vol: 0.4 });
      if (!menuOpen) return;
      menuOpen = false;
      menuEl.setAttribute('aria-hidden', 'true');
      menuEl.classList.remove('is-visible');
      htmlEl.classList.remove('input-filter-menu');
      setTimeout(() => { if (!menuOpen) menuEl.classList.remove('is-displayed'); }, 300);
    }
    document.getElementById('menu-trigger').addEventListener('click', () => openMenu());
    document.getElementById('menu-close').addEventListener('click', closeMenu);
    document.getElementById('menu-btn-play').addEventListener('click', closeMenu);
    document.getElementById('menu-btn-map').addEventListener('click', () => openMap());

    // ---------- Caderno do Ravi: Garagem, Mundos, Corridas e Ajustes novos ----------
    const fmtMs = (ms) => { const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, c = Math.floor(ms % 1000); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(c).padStart(3, '0')}`; };
    function renderGarage() {
      document.querySelectorAll('.garage-card').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.vehicle === currentVehicleType);
        b.classList.toggle('is-disabled', b.dataset.vehicle === 'baja' && !IS_QUINTAL);
      });
      document.getElementById('garage-hint').textContent = IS_QUINTAL ? 'Os dois veículos podem andar no quintal. Só o Baja encara a lama e os obstáculos do rally.'
        : 'O Baja 13 mora no quintal: vá em Mundos ou passe pela porta da parede leste do quarto.';
    }
    document.querySelectorAll('.garage-card').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.vehicle;
      if (v === 'baja' && !IS_QUINTAL) { selectMenuSection('worlds'); sfx('uiError', { vol: 0.4 }); return; }
      closeMenu();
      if (v !== currentVehicleType) switchVehicleModel(v);
    }));
    document.getElementById('menu-btn-paint').addEventListener('click', () => { closeMenu(); openPaintShop(); });
    function renderWorlds() {
      const got = (from, to) => { let n = 0, t = 0; coins.forEach((c) => { if (c.id >= from && c.id < to) { t++; if (coinCollected.has(c.id)) n++; } }); return `🪙 ${n} / ${t} moedas`; };
      document.getElementById('world-stat-quarto').textContent = got(0, 22);
      document.getElementById('world-stat-quintal').textContent = got(22, COIN_COUNT);
      document.querySelectorAll('.world-card[data-world]').forEach((a) => a.classList.toggle('is-here', a.dataset.world === SCENE));
    }
    document.querySelectorAll('.world-card[data-world]').forEach((a) => a.addEventListener('click', (e) => {
      if (a.dataset.world === SCENE) { e.preventDefault(); closeMenu(); }
    }));
    function renderRecords() {
      const rows = [
        ['🏁', 'Circuito do Ravi (melhor volta)', leaderboard.length ? fmtMs(Math.min(...leaderboard.map((r) => r.time))) : '—'],
        ['🏎️', 'Rally do Baja (melhor volta)', rallyLap.best ? fmtMs(rallyLap.best) : '—'],
        ['🎳', 'Boliche (maior placar)', bowlingBest ? String(bowlingBest) : '—']
      ];
      document.getElementById('race-records').innerHTML = rows.map(([e, l, v]) => `<div class="rec"><span>${e}</span><span>${l}</span><b>${v.includes('NaN') || v.includes('Infinity') ? '—' : v}</b></div>`).join('');
    }
    // Ajustes novos: sensibilidade da direção, tamanho do analógico e modo canhoto (salvos no aparelho)
    let steerSens = 1; // multiplicador do esterço (usado no passo da física)
    const STEER_LEVELS = [['Suave', 0.8], ['Normal', 1], ['Rápida', 1.2]];
    const STICK_LEVELS = [['Pequeno', 'stick-s'], ['Médio', ''], ['Grande', 'stick-l']];
    const prefGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
    const prefSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } };
    let steerLevel = Math.min(2, Math.max(0, parseInt(prefGet('steerLevel', '1'), 10) || 0));
    let stickLevel = Math.min(2, Math.max(0, parseInt(prefGet('stickLevel', '1'), 10) || 0));
    let leftHanded = prefGet('leftHanded', '0') === '1';
    function applyControlPrefs() {
      steerSens = STEER_LEVELS[steerLevel][1];
      htmlEl.classList.remove('stick-s', 'stick-l');
      if (STICK_LEVELS[stickLevel][1]) htmlEl.classList.add(STICK_LEVELS[stickLevel][1]);
      htmlEl.classList.toggle('is-lefty', leftHanded);
      document.querySelector('#opt-steer span').textContent = STEER_LEVELS[steerLevel][0];
      document.querySelector('#opt-stick span').textContent = STICK_LEVELS[stickLevel][0];
      document.querySelector('#opt-hand span').textContent = leftHanded ? 'Canhoto' : 'Destro';
    }
    document.getElementById('opt-steer').addEventListener('click', () => { steerLevel = (steerLevel + 1) % 3; prefSet('steerLevel', steerLevel); applyControlPrefs(); });
    document.getElementById('opt-stick').addEventListener('click', () => { stickLevel = (stickLevel + 1) % 3; prefSet('stickLevel', stickLevel); applyControlPrefs(); });
    document.getElementById('opt-hand').addEventListener('click', () => { leftHanded = !leftHanded; prefSet('leftHanded', leftHanded ? '1' : '0'); applyControlPrefs(); });
    applyControlPrefs();

    // Abas de controles (.tabs)
    document.querySelectorAll('#controls-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tabsName;
        document.querySelectorAll('#controls-tabs .tab').forEach(t => t.classList.toggle('is-active', t === tab));
        document.querySelectorAll('#controls-tabs .tabs-content-item').forEach(c => c.classList.toggle('is-active', c.dataset.tabsName === name));
      });
    });
    if (htmlEl.classList.contains('is-mode-touch')) document.querySelector('#controls-tabs .tab[data-tabs-name="touch"]').click();

    // Qualidade (sombras + resolução)
    const optQualityEl = document.getElementById('opt-quality');
    const optAudioEl = document.getElementById('opt-audio');
    function syncAudioButton() {
      optAudioEl.querySelector('span').textContent = sfxState.enabled ? 'Ligado' : 'Desligado';
      optAudioEl.classList.toggle('is-danger', !sfxState.enabled);
    }
    optAudioEl.addEventListener('click', () => {
      setAudioEnabled(!sfxState.enabled);
      syncAudioButton();
      if (sfxState.enabled) sfx('uiToggle', { vol: 0.5 });
    });
    syncAudioButton();
    document.getElementById('opt-unstuck').addEventListener('click', () => { closeMenu(); unstuckCar(); });
    document.getElementById('opt-respawn').addEventListener('click', () => { closeMenu(); respawnClosest(); });
    const optDayEl = document.getElementById('opt-daycycle');
    const DAY_MODES = ['auto', 'day', 'night'], DAY_LABELS = { auto: 'Automático', day: 'Dia', night: 'Noite' };
    const syncDayButton = () => { optDayEl.querySelector('span').textContent = DAY_LABELS[dayCycle.mode] || 'Automático'; };
    optDayEl.addEventListener('click', () => {
      dayCycle.mode = DAY_MODES[(DAY_MODES.indexOf(dayCycle.mode) + 1) % DAY_MODES.length];
      try { localStorage.setItem('dayCycleMode', dayCycle.mode); } catch (e) { /* sem storage */ }
      syncDayButton();
    });
    syncDayButton();
    // Clique em qualquer botão da interface: "clique" discreto (como no DS)
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button, .button');
      if (b && b !== optAudioEl) sfx('uiClick', { vol: 0.28 });
    }, true);
    let highQuality = true;
    try { highQuality = localStorage.getItem('fire_engine_quality') !== 'low'; } catch (e) { /* ignora */ }
    function applyQuality() {
      renderer.setPixelRatio(highQuality ? Math.min(window.devicePixelRatio, 2) : 1);
      renderer.shadowMap.enabled = highQuality;
      window.__highQuality = highQuality;
      decorLights.forEach((l) => { l.visible = highQuality; });
      scene.traverse((o) => {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
      });
      optQualityEl.querySelector('span').textContent = highQuality ? 'Alta' : 'Baixa';
      optQualityEl.classList.toggle('is-success', highQuality);
    }
    // Detecção automática: se o aparelho estiver lento nos primeiros segundos de jogo (e a pessoa nunca escolheu
    // a qualidade), muda para Baixa uma única vez e avisa
    (function autoQuality() {
      let chosen = null;
      try { chosen = localStorage.getItem('fire_engine_quality'); } catch (e) { /* ignora */ }
      if (chosen || !highQuality) return;
      let frames = 0, start = 0;
      function sample(now) {
        if (introActive || document.hidden) { start = 0; frames = 0; requestAnimationFrame(sample); return; }
        if (!start) start = now;
        frames++;
        if (now - start < 5000) { requestAnimationFrame(sample); return; }
        const fps = frames / ((now - start) / 1000);
        if (fps < 32) {
          highQuality = false;
          applyQuality();
          notify({ type: 'info', title: 'Qualidade ajustada', description: `O jogo estava a ${Math.round(fps)} quadros/s: mudei para qualidade Baixa (dá para trocar em Opções).`, duration: 6000 });
        }
      }
      requestAnimationFrame(sample);
    })();
    optQualityEl.addEventListener('click', () => {
      highQuality = !highQuality;
      try { localStorage.setItem('fire_engine_quality', highQuality ? 'high' : 'low'); } catch (e) { /* ignora */ }
      applyQuality();
    });
    document.getElementById('opt-reset').addEventListener('click', () => {
      openModal('Reiniciar a partida?', 'O carrinho volta para a largada e todos os objetos são restaurados. As conquistas são mantidas.', false);
    });

    // ---------- Modais (.modals) ----------
    const modalsEl = document.getElementById('modals');
    const modalPanels = [...modalsEl.querySelectorAll('.modal')];
    const modalTitle = document.getElementById('modal-title');
    const modalDesc = document.getElementById('modal-desc');
    const modalBtn = document.getElementById('modal-btn');

    function openModalPanel(name) {
      if (menuOpen) closeMenu();
      releaseAllKeys();
      modalsOpen = name;
      modalPanels.forEach(p => p.classList.toggle('is-displayed', p.dataset.name === name));
      modalsEl.classList.add('is-displayed');
      htmlEl.classList.add('input-filter-modal');
      requestAnimationFrame(() => modalsEl.classList.add('is-visible'));
    }
    function closeModals() {
      if (!modalsOpen) return;
      modalsOpen = null;
      modalsEl.classList.remove('is-visible');
      htmlEl.classList.remove('input-filter-modal');
      setTimeout(() => { if (!modalsOpen) modalsEl.classList.remove('is-displayed'); }, 300);
    }
    // Clique fora do conteúdo fecha (exceto quando o jogo precisa reiniciar)
    modalsEl.addEventListener('pointerdown', (e) => {
      if (e.target === modalsEl) closeModalFromUser();
    });

    function openModal(title, desc, requiresReset = true) {
      isModalOpen = requiresReset;
      modalRequiresReset = requiresReset;
      modalTitle.textContent = title;
      modalDesc.textContent = desc;
      openModalPanel('reset');
      logInteractionEvent(title);
    }
    function closeModalFromUser() {
      if (modalsOpen === 'reset' && modalRequiresReset) { resetAllGameState(); return; }
      closeModals();
    }
    document.getElementById('modal-close').addEventListener('click', closeModalFromUser);
    modalBtn.addEventListener('click', () => resetAllGameState());

    // ---------- Mapa / fast travel ----------
    // Enquadramento do mapa = interior das 4 paredes do quarto expandido (x -170..240, z -75..95)
    const MAP_MIN_X = IS_QUINTAL ? 118 : -170, MAP_MAX_X = IS_QUINTAL ? 342 : 240, MAP_MIN_Z = IS_QUINTAL ? -82 : -75, MAP_MAX_Z = IS_QUINTAL ? 102 : 95;
    const MAP_W = MAP_MAX_X - MAP_MIN_X, MAP_D = MAP_MAX_Z - MAP_MIN_Z;
    const mapTextureEl = document.getElementById('map-texture');
    const mapPlayerEl = document.getElementById('map-player');
    const mapContainerEl = document.getElementById('map-container');
    const MAP_LOCATIONS = [
      { name: 'Largada', x: 11.5, z: 11.5, angle: -0.55 },
      { name: "Copo d'água", x: -21, z: 22, angle: Math.PI },
      { name: 'Lápis', x: -10, z: 40, angle: -Math.PI / 2 },
      { name: 'Teclado', x: 4.5, z: 13, angle: Math.PI },
      { name: 'Notebook', x: -21, z: 8, angle: Math.PI },
      { name: 'Rádio', x: -47, z: -4, angle: Math.PI + 0.42 },
      { name: 'Aquário', x: 64, z: -4, angle: Math.PI / 2 },
      { name: 'Rampa', x: -78, z: 18, angle: -Math.PI / 2 },
      { name: 'Circuito', race: true },
      { name: 'Posto do Bombeiro', x: -104, z: 70, angle: -Math.PI / 2, floor: true },
      { name: 'Ilha Espacial', x: -124, z: -44, angle: -2.3, floor: true },
      { name: 'Ilha da Música', x: 88, z: -36, angle: 2.2, floor: true },
      { name: 'Ilha dos Brinquedos', x: -36, z: 70, angle: -Math.PI / 2, floor: true },
      { name: 'Lago', x: 52, z: 62, angle: Math.PI / 2, floor: true },
      { name: 'Boliche', x: 42, z: 52, angle: 0, floor: true },
      { name: 'Cama do Ravi', x: 88, z: 8, angle: Math.PI / 2, floor: true },
      { name: 'Largada do Rally', x: rallySampleAt(0.012).x, z: rallySampleAt(0.012).z, angle: Math.atan2(rallySampleAt(0.012).tx, rallySampleAt(0.012).tz), floor: true },
      { name: 'Ponte do Rally', x: rallySamples[RALLY_CROSSINGS[0].over - 22].x, z: rallySamples[RALLY_CROSSINGS[0].over - 22].z, angle: Math.atan2(rallySamples[RALLY_CROSSINGS[0].over - 22].tx, rallySamples[RALLY_CROSSINGS[0].over - 22].tz), floor: true },
      { name: 'Montanha da Cachoeira', x: rallySamples[RALLY_CROSSINGS[1].under - 24].x, z: rallySamples[RALLY_CROSSINGS[1].under - 24].z, angle: Math.atan2(rallySamples[RALLY_CROSSINGS[1].under - 24].tx, rallySamples[RALLY_CROSSINGS[1].under - 24].tz), floor: true },
      { name: 'Ilha do Baja (Thiago Ribeiro)', x: 185, z: 56, angle: -Math.PI / 2, floor: true },
      { name: 'Ilha da Fogueira', x: 160, z: 62, angle: -2.4, floor: true }
    ];
    // Cada página só mostra os pontos do próprio cenário
    for (let i = MAP_LOCATIONS.length - 1; i >= 0; i--) {
      const l = MAP_LOCATIONS[i];
      const inQuintal = l.x !== undefined && l.x >= QUINTAL_MIN_X;
      if (l.race ? IS_QUINTAL : inQuintal !== IS_QUINTAL) MAP_LOCATIONS.splice(i, 1);
    }
    function worldToMap(x, z) {
      return { left: ((x - MAP_MIN_X) / MAP_W) * 100, top: ((z - MAP_MIN_Z) / MAP_D) * 100 };
    }
    MAP_LOCATIONS.forEach((loc) => {
      if (loc.race) { loc.x = raceGates[0].x; loc.z = raceGates[0].z; }
      const p = worldToMap(loc.x, loc.z);
      const el = document.createElement('div');
      el.className = 'location';
      el.style.left = p.left + '%';
      el.style.top = p.top + '%';
      el.style.zIndex = String(Math.round(p.top * 10));
      el.innerHTML = '<div class="pin"></div><div class="name-container"><div class="name"></div></div>';
      el.querySelector('.name').textContent = loc.name;
      el.addEventListener('click', () => {
        if (loc.race) { closeModals(); startRaceCountdown(); unlockAchievement('traveler'); }
        else teleportVehicle(loc);
      });
      mapContainerEl.appendChild(el);
    });

    function captureMapTexture() {
      const W = 1180, H = Math.round(1180 * MAP_D / MAP_W);
      const cx = (MAP_MIN_X + MAP_MAX_X) / 2, cz = (MAP_MIN_Z + MAP_MAX_Z) / 2;
      const cam = new THREE.OrthographicCamera(-MAP_W / 2, MAP_W / 2, MAP_D / 2, -MAP_D / 2, 1, 500);
      cam.position.set(cx, 220, cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(cx, 0, cz);
      const rt = new THREE.WebGLRenderTarget(W, H);
      rt.texture.encoding = THREE.sRGBEncoding;
      const prevBg = scene.background;
      const tcVisible = transformControl.visible;
      scene.background = new THREE.Color(0x1d1721);
      transformControl.visible = false;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      const px = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
      renderer.setRenderTarget(null);
      scene.background = prevBg;
      transformControl.visible = tcVisible;
      rt.dispose();
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      for (let row = 0; row < H; row++) {
        img.data.set(px.subarray((H - 1 - row) * W * 4, (H - row) * W * 4), row * W * 4);
      }
      ctx.putImageData(img, 0, 0);
      mapTextureEl.src = c.toDataURL('image/jpeg', 0.85);
    }
    function updateMapPlayer() {
      if (modalsOpen !== 'map') return;
      const p = worldToMap(vehicle.position.x, vehicle.position.z);
      mapPlayerEl.style.left = p.left + '%';
      mapPlayerEl.style.top = p.top + '%';
      mapPlayerEl.style.transform = `rotate(${Math.PI - carAngle}rad)`;
    }
    function openMap() {
      if (introActive || isModalOpen) return;
      captureMapTexture();
      mapPlayerEl.classList.remove('is-bouncing');
      void mapPlayerEl.offsetWidth;
      mapPlayerEl.classList.add('is-bouncing');
      openModalPanel('map');
      updateMapPlayer();
    }
    document.getElementById('map-trigger').addEventListener('click', openMap);
    document.getElementById('map-close').addEventListener('click', closeModals);

    function teleportVehicle(loc) {
      if (heldItem) releaseHeldItem();
      isFallingOff = false;
      carAirborne = false;
      carOnRamp = false;
      isSomersaulting = false;
      fallVelocityY = 0;
      carSpeed = 0;
      carAngle = loc.angle;
      carPitch = 0; carRoll = 0;
      if (typeof rallyLap !== 'undefined') { rallyLap.active = false; rallyLap.half = false; } // teleporte não vale volta do rally
      const ground = sampleGround(loc.x, loc.z, loc.floor ? FLOOR_CAR_Y : CAR_DESK_Y);
      vehicle.position.set(loc.x, ground.y, loc.z);
      vehicle.rotation.set(0, carAngle, 0);
      carBodyGroup.rotation.set(0, 0, 0);
      carBodyGroup.position.set(0, 0, 0);
      closeModals();
      if (loc.silent) return;
      showCarSpeech('Teleporte!', 1600);
      setStatusBanner(`📍 Viajou para: ${loc.name}`, '#35e0ff');
      logInteractionEvent(`📍 Fast travel pelo mapa: ${loc.name}`);
      unlockAchievement('traveler');
    }

    // ---------- Intro / carregamento ----------
    const introEl = document.getElementById('intro');
    const introProgressEl = document.getElementById('intro-progress');
    const introTextEl = document.getElementById('intro-text');
    const introStartEl = document.getElementById('intro-start');
    let introReady = false;
    function setIntroReady() {
      if (introReady) return;
      introReady = true;
      introProgressEl.style.strokeDashoffset = '0';
      introTextEl.textContent = 'Tudo pronto! Dirija com WASD ou pelo direcional na tela.';
      introStartEl.classList.remove('is-disabled');
    }
    THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => {
      introProgressEl.style.strokeDashoffset = String(314.16 * (1 - loaded / Math.max(1, total)));
      introTextEl.textContent = `Carregando modelos 3D… ${loaded}/${total}`;
    };
    THREE.DefaultLoadingManager.onLoad = setIntroReady;
    setTimeout(setIntroReady, 9000); // nunca prende o jogador se algum arquivo falhar

    function startExperience() {
      if (IS_QUINTAL) setTimeout(() => { if (currentVehicleType !== 'baja') switchVehicleModel('baja'); else teleportVehicle(rallyStartLocation()); }, 60);
      if (!introActive || !introReady) return;
      introActive = false;
      introEl.classList.add('is-hidden');
      htmlEl.classList.add('is-started');
      setTimeout(() => { introEl.style.display = 'none'; }, 700);
      applySavedLayout();
      pruneTinyShadowCasters();
      setTimeout(pruneTinyShadowCasters, 4000);
      spawnRevealWave(vehicle.position.x, vehicle.position.y, vehicle.position.z);
      getAudio(); // o áudio só pode iniciar após um gesto do usuário
      // Celular: tela cheia + travar na horizontal (Android/Chrome; no iOS fica o aviso "deite o celular")
      if (htmlEl.classList.contains('is-mode-touch')) {
        const el = document.documentElement;
        const fs = el.requestFullscreen || el.webkitRequestFullscreen;
        if (fs) {
          Promise.resolve(fs.call(el)).then(() => {
            if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
          }).catch(() => {});
        }
      }
      logInteractionEvent('🚒 Carrinho do Ravi pronto na mesa!');
      notify({ type: 'info', title: 'Bem-vindo à mesa!', description: 'Abra o menu (☰) ou o mapa para explorar', duration: 4500 });
    }
    introStartEl.addEventListener('click', startExperience);

    // ============================================================================
    // SEGURAR E ARRASTAR OBJETOS (LÁPIS DE COR, CABOS HDMI, CANECA, ETC.)
    // ============================================================================
    function itemRestOffset(item) {
      if (item.restOffset === undefined) item.restOffset = item.initY - surfaceBaseY(item.initY);
      return item.restOffset;
    }

    function releaseHeldItem() {
      if (!heldItem) return;
      const item = heldItem;
      heldItem = null;
      sfx('release', { vol: 0.45 });
      grabBtnEl.classList.remove('is-holding');
      grabLabelEl.textContent = 'Pegar';
      // Repousa o objeto na superfície em que o carrinho está (mesa ou chão)
      item.group.position.y = surfaceBaseY(vehicle.position.y) + itemRestOffset(item);
      if (item.obs) {
        item.obs.x = item.group.position.x;
        item.obs.z = item.group.position.z;
        item.obs.level = levelOfY(item.group.position.y);
        if (item.obs._dyn) { item.obs.vx = 0; item.obs.vz = 0; item.obs.vRotY = 0; }
      }
      if (item.onRelease) item.onRelease(item.group.position.x, item.group.position.z);
      if (item.obs && !item.obs._dyn) staticGridCount = -1; // obstáculo fixo mudou de lugar: refaz a grade
      if (item.id === 'water_pistol') updateWaterHUD();
      logInteractionEvent(`🫳 Soltou: ${item.name}`);
      setStatusBanner(`🫳 Objeto solto: ${item.name}`);
    }

    function toggleGrabItem() {
      if (inputBlocked()) return;
      if (heldItem) { releaseHeldItem(); return; }
      const carLevel = levelOfY(vehicle.position.y);
      let best = null;
      let bestDist = Infinity;
      grabbableItems.forEach((item) => {
        if (item.cableRef && item.cableRef.connected) return;
        if (levelOfY(item.group.position.y) !== carLevel) return; // mesmo nível (mesa x chão)
        if (item.obs && item.obs.isFalling) return;
        const d = Math.hypot(vehicle.position.x - item.group.position.x, vehicle.position.z - item.group.position.z);
        const maxR = item.grabRadius || 5.2;
        if (d < maxR && d < bestDist) { bestDist = d; best = item; }
      });
      if (best) {
        heldItem = best;
        itemRestOffset(best);
        sfx('grab', { vol: 0.5 });
        if (best.id === 'water_pistol') {
          showCarSpeech('Reservatório extra! Tanque até 200% 💦', 2600);
          notify({ type: 'info', title: "Pistola d'água conectada", description: `Encha na poça, no lago ou no posto: o carrinho leva até 200% (pistola com ${Math.round(pistolWater)}%).`, duration: 4200 });
          updateWaterHUD();
        }
        if (best.clipBox) { best.clipBox.lastX = best.group.position.x; best.clipBox.lastZ = best.group.position.z; }
        grabBtnEl.classList.add('is-holding');
        grabLabelEl.textContent = 'Soltar';
        logInteractionEvent(`🧲 Segurando: ${best.name}`);
        setStatusBanner(`🧲 Segurando: ${best.name} (arraste pela mesa!)`, '#7ee787');
      } else {
        setStatusBanner('ℹ️ Aproxime-se de um objeto (lápis, pistola d\'água, caneca, plantinha) para pegar!');
      }
    }

    // ============================================================================
    // ÁGUA DO CARRINHO: REGAR PLANTAS E APAGAR O INCÊNDIO DO MONITOR
    // ============================================================================
    let waterLevel = 100.0;
    // Pistola d'água = reservatório extra: segurando ela, o carrinho leva até 200% (100% no tanque + 100% na pistola)
    let pistolWater = 0;
    const PISTOL_CAP = 100;
    const holdingPistol = () => !!(heldItem && heldItem.id === 'water_pistol');
    const waterCapacity = () => (holdingPistol() ? 100 + PISTOL_CAP : 100);
    const totalWater = () => waterLevel + (holdingPistol() ? pistolWater : 0);
    function addWater(amount) {
      const toTank = Math.min(amount, 100 - waterLevel);
      if (toTank > 0) { waterLevel += toTank; amount -= toTank; }
      if (amount > 0 && holdingPistol()) pistolWater = Math.min(PISTOL_CAP, pistolWater + amount);
    }
    function useWater(amount) {
      const fromTank = Math.min(amount, waterLevel);
      waterLevel -= fromTank; amount -= fromTank;
      if (amount > 0 && holdingPistol()) pistolWater = Math.max(0, pistolWater - amount);
    }
    function updateWaterHUD() {
      const total = Math.round(totalWater());
      const pct = clamp(total, 0, 200);
      waterPctEl.textContent = pct + '%' + (!holdingPistol() && pistolWater >= 1 ? ` (+${Math.round(pistolWater)}% na pistola)` : '');
      waterBarEl.style.transform = `scaleX(${Math.min(1, pct / 100)})`;
      waterBarEl.style.filter = pct > 100 ? `hue-rotate(${Math.round((pct - 100) * 0.6)}deg) brightness(1.15)` : '';
      hudWaterEl.classList.toggle('is-low', pct <= 15);
    }

    // ---------- Bateria do carrinho (pilha) ----------
    // Gasta pouco ao acelerar; recarrega nas pilhas palito e no Posto do Bombeiro (ilha do Ravi).
    // Turbo das pilhas só com mais de 60%; abaixo de 10% o carrinho perde a força.
    let carBattery = 100;
    let batteryLowWarned = false;
    const batteryPctEl = document.getElementById('battery-pct');
    const batteryBarEl = document.getElementById('battery-bar');
    const batteryFillEl = document.getElementById('battery-bar-fill');
    // Acima de 100% = sobrecarga; acima de 120% = NITRO; passar de 140% = explosão (bateria volta a 5%)
    const BATTERY_MAX = 140, BATTERY_NITRO_AT = 120;
    let nitroActive = false;
    let overchargeWarned = false;
    function updateBatteryHUD() {
      const pct = clamp(Math.round(carBattery), 0, BATTERY_MAX);
      batteryPctEl.textContent = pct + '%';
      batteryFillEl.style.transform = `scaleX(${pct / BATTERY_MAX})`;
      batteryBarEl.classList.toggle('is-low', carBattery < 10);
      batteryBarEl.classList.toggle('is-turbo', carBattery > 60 && carBattery <= 100);
      batteryBarEl.classList.toggle('is-over', carBattery > 100 && carBattery < BATTERY_NITRO_AT);
      batteryBarEl.classList.toggle('is-nitro', carBattery >= BATTERY_NITRO_AT);
      batteryBarEl.classList.toggle('is-danger', carBattery > 132);
    }
    function chargeBattery(amount, source) {
      const before = carBattery;
      carBattery = carBattery + amount;
      if (before < 10 && carBattery >= 10) {
        batteryLowWarned = false;
        showCarSpeech('Energia de volta!', 1600);
      }
      if (carBattery > BATTERY_MAX) {
        overloadExplosion();
        return before;
      }
      if (carBattery > 100 && before <= 100) {
        showCarSpeech('Sobrecarga! ⚡', 1800);
        notify({ type: 'danger', title: 'Sobrecarga!', description: 'Acima de 120% vira NITRO. Passou de 140%... BUM!', duration: 3500 });
      }
      if (carBattery > 130 && !overchargeWarned) {
        overchargeWarned = true;
        showCarSpeech('Cuidado! Vou explodir!', 2000);
        setStatusBanner(`⚠️ Bateria em ${Math.round(carBattery)}% — mais uma carga e o carrinho explode!`, '#ff5252');
      }
      if (carBattery <= 125) overchargeWarned = false;
      updateBatteryHUD();
      return before;
    }
    // Coleta de pilha: a pilha palito aparece apenas uma única vez na cena (coerente com a conquista)
    function collectBattery(tb, time) {
      const type = tb.type;
      tb.collected = true;
      tb.respawnAt = 0; // Nunca mais respawna
      tb.group.visible = false;
      if (tb.bolt) tb.bolt.visible = false;
      trackAchievementSet('turbo', tb.id);
      saveAchievements();
      const p = tb.group.position;
      for (let i = 0; i < (type.gold ? 18 : 8); i++) {
        const a = Math.random() * Math.PI * 2;
        spawnFx(p.x, p.y + 0.6, p.z, Math.cos(a) * 3, 4 + Math.random() * 3, Math.sin(a) * 3, type.ring, 0.35, 18, 0.7);
      }
      if (type.gold) {
        // Dourada: vai direto a 120% (NITRO) sem nunca explodir, qualquer que seja a carga atual
        const before = carBattery;
        carBattery = Math.min(BATTERY_MAX, Math.max(carBattery, BATTERY_NITRO_AT));
        batteryLowWarned = false;
        updateBatteryHUD();
        turboBoostTimer = 1.65;
        carSpeed = Math.max(carSpeed, baseMaxSpeed * 1.85);
        showCarSpeech('✨ PILHA DOURADA! NITRO!', 2400);
        setStatusBanner(`✨ Pilha turbo dourada: bateria em ${Math.round(carBattery)}% (sem risco de explodir)`, '#ffd700');
        notify({ type: 'success', title: 'Pilha turbo dourada!', description: 'Bateria em 120%: modo NITRO garantido, sem explosão.', duration: 4000 });
        logInteractionEvent(`✨ Pilha dourada: ${Math.round(before)}% → ${Math.round(carBattery)}%`);
        rumble(0.5, 0.8, 260);
        if (!sfx('powerGold', { vol: 0.7 })) { playTone(784, 0, 0.1, 'triangle', 0.07); playTone(1046, 0.1, 0.12, 'triangle', 0.07); playTone(1318, 0.2, 0.2, 'triangle', 0.07); }
        return;
      }
      const amount = Math.round(type.min + Math.random() * (type.max - type.min));
      const before = chargeBattery(amount);
      if (before + amount > BATTERY_MAX) return; // explodiu: a explosão já cuidou dos avisos
      if (before > 60 && tb.kind !== 'weak') {
        // Turbo das pilhas só com bateria acima de 60% (pilha fraca não dá turbo)
        turboBoostTimer = 1.65;
        carSpeed = baseMaxSpeed * 1.85;
        showCarSpeech(`⚡ MINI TURBO! +${amount}%`, 1800);
        setStatusBanner(`⚡ ${type.label}: MINI TURBO! +${amount}% (bateria ${Math.round(carBattery)}%)`, '#35e0ff');
        rumble(0.25, 0.5, 160);
      } else {
        showCarSpeech(`🔋 +${amount}%`, 1600);
        setStatusBanner(`🔋 ${type.label}: +${amount}% (bateria ${Math.round(carBattery)}%)`, tb.kind === 'weak' ? '#b0b4ba' : '#7ee787');
        rumble(0.15, 0.25, 90);
      }
      logInteractionEvent(`🔋 ${type.label}: +${amount}% de bateria`);
      playTone(660, 0, 0.1, 'triangle', 0.06); playTone(990, 0.08, 0.12, 'triangle', 0.05);
    }

    // Enche só até 100% (posto do bombeiro, reset): nunca causa sobrecarga
    function fillBatteryTo100() {
      if (carBattery < 100) chargeBattery(100 - carBattery);
    }

    // Nitro: chamas azuis duplas no escapamento traseiro
    const nitroFlames = [];
    const nitroFlameMat = new THREE.MeshBasicMaterial({ color: 0x6fd6ff, transparent: true, opacity: 0.9, depthWrite: false });
    const nitroCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    [-0.62, 0.62].forEach((x) => {
      const flame = new THREE.Group();
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.6, 12), nitroFlameMat);
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 10), nitroCoreMat);
      outer.rotation.x = inner.rotation.x = -Math.PI / 2; // ponta para trás (-z)
      outer.position.z = -0.8; inner.position.z = -0.5;
      flame.add(outer, inner);
      flame.position.set(x, 0.62, -2.2);
      flame.visible = false;
      carBodyGroup.add(flame);
      nitroFlames.push(flame);
    });
    function setNitro(on) {
      nitroActive = on;
      nitroFlames.forEach(f => { f.visible = on; });
      if (on) {
        showCarSpeech('NITROOO! 🔥', 1800);
        setStatusBanner('🔥 Modo NITRO: bateria acima de 120%!', '#6fd6ff');
        if (!sfx('nitro', { vol: 0.5 })) { playTone(220, 0, 0.25, 'sawtooth', 0.06); playTone(440, 0.12, 0.3, 'sawtooth', 0.05); }
        rumble(0.4, 0.6, 200);
        unlockAchievement('nitro');
      }
    }
    function updateNitroFlames(power) {
      const t = performance.now() / 1000;
      nitroFlames.forEach((f, i) => {
        const s = 0.6 + power * 0.7 + Math.sin(t * 40 + i * 2) * 0.15;
        f.scale.set(1, 1, s);
      });
      if (Math.random() < 0.5) {
        const back = new THREE.Vector3(0, 0.7, -2.8).applyQuaternion(vehicle.quaternion).add(vehicle.position);
        spawnFx(back.x, back.y, back.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, Math.random() > 0.4 ? 0x6fd6ff : 0xffffff, 0.35, 0, 0.35);
      }
    }

    // Explosão de sobrecarga (estilo explosão das caixas do mundo do DS): clarão, bola de fogo,
    // fumaça, faíscas e onda de choque. O carrinho NÃO é destruído: só quica e a bateria cai para 5%.
    const explosionFx = [];
    function overloadExplosion() {
      const p = vehicle.position.clone().add(new THREE.Vector3(0, 1.2, 0));
      carBattery = 5;
      batteryLowWarned = false;
      overchargeWarned = false;
      setNitro(false);
      updateBatteryHUD();
      // Clarão + bola de fogo
      const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 1, depthWrite: false }));
      flash.position.copy(p);
      scene.add(flash);
      explosionFx.push({ mesh: flash, t: 0, life: 0.55, grow: 9, kind: 'flash' });
      const fire = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0xff4500, emissiveIntensity: 1.2, flatShading: true, transparent: true, depthWrite: false }));
      fire.position.copy(p);
      scene.add(fire);
      explosionFx.push({ mesh: fire, t: 0, life: 0.9, grow: 6, kind: 'fire' });
      // Fumaça low-poly subindo
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * Math.PI * 2;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + Math.random() * 0.6, 0), new THREE.MeshStandardMaterial({ color: 0x5b5560, flatShading: true, transparent: true, depthWrite: false, roughness: 1 }));
        puff.position.copy(p).add(new THREE.Vector3(Math.cos(a) * 1.2, Math.random(), Math.sin(a) * 1.2));
        scene.add(puff);
        explosionFx.push({ mesh: puff, t: 0, life: 1.6 + Math.random() * 0.8, grow: 2.6, kind: 'smoke', vx: Math.cos(a) * 3, vy: 4 + Math.random() * 3, vz: Math.sin(a) * 3 });
      }
      // Onda de choque no chão
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.2, 40), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, vehicle.position.y + 0.25, p.z);
      scene.add(ring);
      explosionFx.push({ mesh: ring, t: 0, life: 0.7, grow: 14, kind: 'ring' });
      // Faíscas e confete
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2, s = 6 + Math.random() * 8;
        spawnFx(p.x, p.y, p.z, Math.cos(a) * s, 6 + Math.random() * 10, Math.sin(a) * s, [0xffc300, 0xff6a3d, 0xffffff, 0xe63946][i % 4], 0.5 + Math.random() * 0.5, 22, 1.2);
      }
      // Empurra os objetos em volta e faz o carrinho dar um pulo (sem ser destruído)
      const carLvl = levelOfY(vehicle.position.y);
      dynamicObstacles.forEach((o) => {
        if (o.level !== carLvl) return;
        const dx = o.x - vehicle.position.x, dz = o.z - vehicle.position.z, d = Math.hypot(dx, dz);
        if (d > 14 || d < 1e-3) return;
        const f = (1 - d / 14) * 1.6 / (o.mass || 1);
        o.vx += (dx / d) * f; o.vz += (dz / d) * f;
        if (o.ball) o.hopV = Math.max(o.hopV || 0, 0.45 * (1 - d / 14));
        if (o.pin) knockPin(o, dx / d, dz / d);
        if (o.crate) explodeCrate(o);
      });
      carSpeed *= 0.2;
      if (!carAirborne) launchVehicle(0.55);
      // Som: estrondo grave + chiado
      if (!(sfx('boom', { vol: 0.9, rate: 0.8 }) && sfx('boomTail', { vol: 0.5, delay: 0.08 }))) {
        playTone(70, 0, 0.7, 'sawtooth', 0.14);
        playTone(110, 0.02, 0.5, 'square', 0.1);
        playTone(55, 0.1, 0.9, 'sawtooth', 0.1);
      }
      rumble(1, 1, 500);
      explosionShake = 0.9;
      showCarSpeech('BUUUM! Bateria em 5%...', 2800);
      setStatusBanner('💥 Sobrecarga! A bateria explodiu e caiu para 5% — recarregue nas pilhas ou no Posto.', '#ff5252');
      notify({ type: 'danger', title: 'Sobrecarga: BUM!', description: 'A bateria passou de 140% e explodiu. O carrinho está inteiro, mas com 5% de energia.', duration: 5000 });
      logInteractionEvent('💥 Sobrecarga! A bateria passou de 140% e explodiu (bateria em 5%).');
      unlockAchievement('kaboom');
    }
    let explosionShake = 0;
    function updateExplosionFx(dt) {
      for (let i = explosionFx.length - 1; i >= 0; i--) {
        const e = explosionFx[i];
        e.t += dt;
        const k = e.t / e.life;
        if (k >= 1) { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); explosionFx.splice(i, 1); continue; }
        const ease = 1 - Math.pow(1 - k, 3);
        if (e.kind === 'smoke') {
          e.mesh.position.x += e.vx * dt; e.mesh.position.y += e.vy * dt; e.mesh.position.z += e.vz * dt;
          e.vx *= 0.96; e.vz *= 0.96; e.vy *= 0.97;
          e.mesh.scale.setScalar(1 + ease * e.grow);
          e.mesh.material.opacity = 0.85 * (1 - k);
          e.mesh.rotation.y += dt;
        } else {
          e.mesh.scale.setScalar(1 + ease * e.grow);
          e.mesh.material.opacity = (e.kind === 'flash' ? 1 : 0.95) * (1 - k);
          if (e.kind === 'fire') e.mesh.rotation.y += dt * 2;
        }
      }
      if (explosionShake > 0) explosionShake = Math.max(0, explosionShake - dt * 1.6);
    }

    const waterDrops = [];
    const dropGeo = new THREE.SphereGeometry(0.18, 8, 8);
    const dropMat = new THREE.MeshBasicMaterial({ color: 0x35e0ff });

    function spawnWaterJet() {
      if (inputBlocked() || isFallingOff) return;
      if (currentVehicleType === 'baja') {
        const now = performance.now();
        if (now - (spawnWaterJet.lastMsg || 0) > 3000) { spawnWaterJet.lastMsg = now; showCarSpeech('O Baja não tem mangueira! 🏎️', 1800); }
        return;
      }
      if (totalWater() <= 0) {
        setStatusBanner('⚠️ SEM ÁGUA! Derrube o copo branco e pare na poça!', '#ff5252');
        logInteractionEvent('⚠️ Tanque de água vazio! Derrube o copo para abastecer.');
        return;
      }
      useWater(0.85);
      updateWaterHUD();
      yellowRoofButton.position.y = 2.50;
      setTimeout(() => { yellowRoofButton.position.y = 2.56; }, 120);
      const groundY = surfaceBaseY(vehicle.position.y) + 0.1;
      for (let i = 0; i < 3; i++) {
        const drop = new THREE.Mesh(dropGeo, dropMat);
        const forward = new THREE.Vector3(Math.sin(carAngle), 0.45 + Math.random() * 0.16, Math.cos(carAngle));
        drop.position.copy(vehicle.position).add(new THREE.Vector3(0, 2.95, 0));
        scene.add(drop);
        waterDrops.push({
          mesh: drop,
          vel: forward.multiplyScalar(0.55 + Math.random() * 0.15).add(
            new THREE.Vector3((Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.1)
          ),
          life: 52,
          groundY // gotas no chão do quarto não somem mais na altura da mesa
        });
      }
    }

    // ============================================================================
    // REINÍCIO DE JOGO
    // ============================================================================
    let isFallingOff = false;
    let fallVelocityY = 0;

    function resetAllGameState() {
      if (heldItem) releaseHeldItem();
      endRace(true);
      isModalOpen = false;
      modalRequiresReset = false;
      closeModals();
      isFallingOff = false;
      carAirborne = false;
      carOnRamp = false;
      isSomersaulting = false;
      somersaultAngle = 0;
      fallVelocityY = 0;
      accelContinuousTime = 0;
      turboBoostTimer = 0;
      carPitch = 0; carRoll = 0;

      vehicle.position.set(11.5, CAR_DESK_Y, 11.5);
      vehicle.rotation.set(0, -0.55, 0);
      carBodyGroup.rotation.set(0, 0, 0);
      carBodyGroup.position.set(0, 0, 0);
      carSpeed = 0;
      carAngle = -0.55;
      waterLevel = 100.0;
      pistolWater = 0;
      updateWaterHUD();
      carBattery = 100; batteryLowWarned = false; overchargeWarned = false; if (nitroActive) setNitro(false); updateBatteryHUD();
      respawnAllBatteries();
      setStatusBanner('🔄 Jogo reiniciado! Todos os objetos restaurados.', '#7ee787');
      logInteractionEvent('🔄 Jogo reiniciado e objetos restaurados!');

      // Copo d'água e poça
      cupSpilled = false;
      resetCupFall();
      cupWaterInside.visible = true;
      puddleMesh.visible = false;
      puddleScale = 0.001;
      puddleMesh.scale.set(0.001, 0.001, 0.001);
      cupObstacle.name = 'COPO COM ÁGUA';

      // Todos os objetos com física voltam à posição original (inclui copo, mouse, caneca, modelos GLB)
      dynamicObstacles.forEach((obs) => {
        obs.x = obs.initX; obs.z = obs.initZ;
        obs.vx = 0; obs.vz = 0; obs.vy = 0; obs.vRotY = 0;
        obs.tiltX = 0; obs.tiltZ = 0;
        obs.isFalling = false;
        if (obs.group) {
          obs.group.position.set(obs.initX, obs.initY !== undefined ? obs.initY : obs.group.position.y, obs.initZ);
          obs.group.rotation.set(0, obs.initRotY || 0, 0);
          obs.level = levelOfY(obs.group.position.y);
        }
      });

      // Arrastáveis + lápis e pista oculta
      resetRaceTrackCanvas();
      pencilDrawTime = 0;
      grabbableItems.forEach((item) => {
        if (item.clipBox) resetClipBox(item);
        if (item.pencil && !item.pencil.special) { item.pencil.ink = item.pencil.maxInk; item.pencil.warned = false; item.group.scale.x = 1; }
        if (item.obs && item.obs.burstBox && item.obs.burstBox.lid) { item.obs.burstBox.empty = false; item.obs.burstBox.lid.visible = true; }
        item.group.position.set(item.initX, item.initY, item.initZ);
        item.group.rotation.set(0, item.initRotY || 0, 0);
        if (item.obs) {
          item.obs.x = item.initX;
          item.obs.z = item.initZ;
          item.obs.level = levelOfY(item.initY);
        }
      });

      // Cabo HDMI desconectado
      hdmi1Connected = false;
      hdmiCables.forEach((c) => { c.connected = false; c.updateCableCurve(); });

      // Plantas no nível 1
      growablePlants.forEach((p) => {
        p.x = p.initX !== undefined ? p.initX : p.x;
        p.z = p.initZ !== undefined ? p.initZ : p.z;
        p.isWatered = false;
        p.growthElapsed = 0;
        p.level = 1;
        p.targetScale = 1.0;
        if (p.foliageGroup && p.foliageGroup.scale) p.foliageGroup.scale.set(1, 1, 1);
        if (p.foliageMeshes) p.foliageMeshes.forEach(m => m.scale.set(1, 1, 1));
        if (p.flowersGroup) p.flowersGroup.visible = false;
        if (p.obs) p.obs.name = `${p.name} (NÍVEL 1)`;
      });

      // Alimentos e plantinhas quebrados voltam inteiros; monitor sai do modo currículo
      resetBreakables();
      // Caixas-surpresa, muros de tijolinhos e boliche voltam ao estado original
      surpriseCrates.forEach((c) => {
        if (c.exploded) { c.exploded = false; c.group.visible = true; c.r = c.savedR; }
      });
      dynamicObstacles.forEach((o) => {
        if (o.initStack !== undefined) { o.stackOffset = o.initStack; o.stackDropping = false; }
        o.hop = 0; o.hopV = 0;
      });
      resetBowling();
      monitorProfileMode = null;

      // Controles e detritos
      controllerDebrisList.forEach(m => { if (m.parent) m.parent.remove(m); });
      controllerDebrisList.length = 0;
      breakableControllers.forEach((c) => {
        c.hits = 0;
        c.stage = 0;
        c.group.position.set(c.initX, 0.14, c.initZ);
        c.group.rotation.set(0, c.initRotY, 0);
        c.obs.x = c.initX;
        c.obs.z = c.initZ;
        c.obs.level = 'desk';
        c.bodyMat.color.setHex(c.origColor);
        c.centerBody.scale.set(1, 1, 1);
        c.centerBody.rotation.set(0, 0, 0);
        c.gripL.visible = true; c.gripL.rotation.set(Math.PI / 2.3, 0, 0.22); c.gripL.position.set(-1.18, 0.38, 0.38);
        c.gripR.visible = true; c.gripR.rotation.set(Math.PI / 2.3, 0, -0.22); c.gripR.position.set(1.18, 0.38, 0.38);
        c.stickL.visible = true; c.stickL.rotation.set(0, 0, 0);
        c.stickR.visible = true; c.stickR.rotation.set(0, 0, 0);
        c.obs.name = `${c.name} (INTACTO)`;
      });

      // Teclado, autodestruição e monitor 1
      typedTextLines = ['> terminal ready...'];
      selfDestructProgress = 0;
      monitorState = 'normal';
      fireTimer = 15.0;
      monitorFireGroup.visible = false;
      fireLight.intensity = 0;
      htmlEl.classList.remove('is-fire');
      monitorHeadGroup.rotation.set(0, 0, 0);
      curvedBack.material.color.setHex(0x131519);
      updateMonitorScreen();
    }

    // ============================================================================
    // CONTROLES (TECLADO + TOUCH)
    // ============================================================================
    const keys = { forward: false, backward: false, left: false, right: false, spray: false, boost: false };
    function releaseAllKeys() {
      Object.keys(keys).forEach(k => { keys[k] = false; });
      document.querySelectorAll('.touch-pad .pressed, .touch-buttons .is-pressed').forEach(b => b.classList.remove('pressed', 'is-pressed'));
    }
    window.addEventListener('blur', releaseAllKeys);

    const MOVE_KEYS = {
      KeyW: 'forward', ArrowUp: 'forward', KeyS: 'backward', ArrowDown: 'backward',
      KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right'
    };

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (introActive) {
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); startExperience(); }
        return;
      }
      if (e.code === 'Escape') {
        if (modalsOpen) closeModalFromUser();
        else if (menuOpen) closeMenu();
        else openMenu();
        return;
      }
      if (isModalOpen) {
        if (e.code === 'Enter') resetAllGameState();
        return;
      }
      if (modalsOpen === 'map' && e.code === 'KeyM') { closeModals(); return; }
      // Navegação por teclado em painéis e no menu (mesmo foco usado pelo controle): setas/WASD movem, Enter/Espaço selecionam
      if ((modalsOpen && modalsOpen !== 'career') || menuOpen) {
        const KEY_DIRS = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0], ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] };
        const dir = KEY_DIRS[e.code];
        if (dir) { e.preventDefault(); moveUiFocus(dir[0], dir[1]); return; }
        if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && uiFocusEl && uiFocusables().includes(uiFocusEl)) {
          e.preventDefault(); activateUiFocus(); return;
        }
      }
      if (modalsOpen === 'island' && e.code === 'Enter') { e.preventDefault(); runPrimaryIslandAction(); return; }
      if (menuOpen || modalsOpen) return;

      if (e.key === 'F2') { e.preventDefault(); toggleDevMode(); return; }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();

      if (MOVE_KEYS[e.code]) keys[MOVE_KEYS[e.code]] = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.boost = true;

      if (e.repeat) return;
      if (e.code === 'KeyW' || e.code === 'ArrowUp') tapAccelerator();
      if (e.code === 'Enter') { e.preventDefault(); interactWithNearest(); }
      if (e.code === 'KeyH') playHonk();
      if (e.code === 'KeyR' && !devModeActive) respawnAtStart();
      if (e.code === 'KeyU' && !devModeActive) unstuckCar();
      if (e.code === 'KeyE') toggleGrabItem();
      if (e.code === 'KeyV') cycleCameraMode();
      if (e.code === 'KeyF') handleJumpPress();
      if (e.code === 'KeyQ') triggerSmallHop();
      if (e.code === 'KeyM') openMap();
      if (e.code === 'Space') {
        if (devModeActive) {
          // Câmera livre só no modo dev (antes disparava junto com o jato d'água e travava a câmera)
          enableFreeCamera(true);
        } else {
          keys.spray = true;
          spawnWaterJet();
        }
      }
      if (devModeActive) {
        if (e.code === 'KeyG') setTransformMode('translate');
        else if (e.code === 'KeyR') setTransformMode('rotate');
        else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelectedDevObject();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (MOVE_KEYS[e.code]) keys[MOVE_KEYS[e.code]] = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.boost = false;
      if (e.code === 'Space') {
        keys.spray = false;
        if (isFreeCameraActive) enableFreeCamera(false);
      }
    });

    function bindTouchButton(id, onStart, onEnd) {
      const btn = document.getElementById(id);
      const start = (e) => { e.preventDefault(); btn.classList.add('pressed', 'is-pressed'); onStart(); };
      const end = (e) => { e.preventDefault(); btn.classList.remove('pressed', 'is-pressed'); if (onEnd) onEnd(); };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    }
    [['t-up', 'forward'], ['t-down', 'backward']].forEach(([id, k]) => {
      bindTouchButton(id, () => { if (!inputBlocked()) keys[k] = true; }, () => { keys[k] = false; });
    });
    bindTouchButton('t-water', () => { if (!inputBlocked()) { keys.spray = true; spawnWaterJet(); } }, () => { keys.spray = false; });
    bindTouchButton('t-jump', () => handleJumpPress());
    bindTouchButton('t-hop', () => triggerSmallHop());
    bindTouchButton('t-grab', () => toggleGrabItem());
    bindTouchButton('t-interact', () => interactWithNearest());
    document.getElementById('t-up').addEventListener('pointerdown', () => tapAccelerator());

    // Analógico virtual (estilo DualSense): nasce onde o polegar toca na metade esquerda da tela.
    // X = direção proporcional; para cima acelera, para baixo dá ré (dá para dirigir só com ele, ou junto com o R2)
    const touchStick = { x: 0, y: 0, id: null, ox: 0, oy: 0 };
    (function setupTouchStick() {
      const zone = document.getElementById('t-stick-zone'), stick = document.getElementById('t-stick'), knob = document.getElementById('t-knob');
      if (!zone || !stick) return;
      const stickR = () => (htmlEl.classList.contains('stick-l') ? 64 : htmlEl.classList.contains('stick-s') ? 42 : 52); // curso máximo do pino (px)
      const place = (cx, cy) => {
        stick.style.transform = '';
        const r = stick.getBoundingClientRect();
        stick.style.transform = `translate(${cx - (r.left + r.width / 2)}px, ${cy - (r.top + r.height / 2)}px)`;
      };
      const move = (e) => {
        let dx = e.clientX - touchStick.ox, dy = e.clientY - touchStick.oy;
        const d = Math.hypot(dx, dy);
        const R = stickR();
        if (d > R) { dx *= R / d; dy *= R / d; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        touchStick.x = dx / R; touchStick.y = dy / R;
      };
      const end = (e) => {
        if (touchStick.id === null || (e && e.pointerId !== undefined && e.pointerId !== touchStick.id)) return;
        touchStick.id = null; touchStick.x = touchStick.y = 0;
        knob.style.transform = ''; stick.style.transform = '';
        stick.classList.remove('is-active', 'is-floating');
      };
      zone.addEventListener('pointerdown', (e) => {
        if (touchStick.id !== null || inputBlocked()) return;
        e.preventDefault();
        touchStick.id = e.pointerId; touchStick.ox = e.clientX; touchStick.oy = e.clientY;
        try { zone.setPointerCapture(e.pointerId); } catch (err) { /* sem captura */ }
        stick.classList.add('is-active', 'is-floating');
        place(e.clientX, e.clientY);
        move(e);
      });
      zone.addEventListener('pointermove', (e) => { if (e.pointerId === touchStick.id) { e.preventDefault(); move(e); } });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => zone.addEventListener(t, end));
      window.addEventListener('blur', () => end(null));
    })();
    // Leitura do analógico com zona morta e curva suave (precisão no centro, esterço total na ponta)
    function touchStickAxes() {
      const dz = (v, z) => { const a = Math.abs(v); return a < z ? 0 : Math.sign(v) * Math.pow((a - z) / (1 - z), 1.25); };
      const sx = dz(touchStick.x, 0.12), sy = dz(touchStick.y, 0.22);
      return { steer: -sx, throttle: Math.max(0, -sy), reverse: Math.max(0, sy - 0.25) / 0.75 };
    }

    // ============================================================================
    // PONTOS INTERATIVOS: ILHAS DO QUARTO + ITENS CENTRAIS DA MESA (RÁDIO E NOTEBOOK)
    // ENTER / ✕ / botão "Interagir"
    // ============================================================================
    const interactPromptEl = document.getElementById('interact-prompt');
    const interactLabelEl = document.getElementById('interact-label');
    const grabPromptEl = document.getElementById('grab-prompt');
    const touchInteractEl = document.getElementById('t-interact');
    const islandModalTitle = document.getElementById('island-title');
    const islandModalText = document.getElementById('island-text');
    const islandActionsEl = document.getElementById('island-actions');
    let nearestInteractive = null;
    let currentIsland = null;
    let currentActions = [];
    const promptAnchor = new THREE.Vector3();

    // ---------- Rádio: músicas do canal oficial (YouTube Music) ----------
    const RADIO_CHANNEL_URL = 'https://www.youtube.com/@jefersonrgomes_oficial';
    const RADIO_FIRST_VIDEO = 'WXxvpysirdk';
    const radioPlayerEl = document.getElementById('radio-player');
    const radioFrameEl = document.getElementById('radio-frame');
    let radioPlaying = false;
    function playRadio() {
      radioFrameEl.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${RADIO_FIRST_VIDEO}?autoplay=1&rel=0&modestbranding=1`;
      iframe.title = 'Rádio do Jheff — YouTube';
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      radioFrameEl.appendChild(iframe);
      radioPlayerEl.classList.add('is-visible');
      radioPlaying = true;
      notify({ type: 'music', title: 'Rádio do Jheff', description: 'Tocando o canal oficial no YouTube Music', duration: 4500 });
      showCarSpeech('🎵 Aumenta o som!', 2200);
      progressAchievement('islandActions', 1);
    }
    function stopRadio() {
      radioFrameEl.innerHTML = '';
      radioPlayerEl.classList.remove('is-visible');
      radioPlaying = false;
    }
    document.getElementById('radio-close').addEventListener('click', stopRadio);

    // ---------- Notebook: currículo (LinkedIn e Trailhead) no monitor ----------
    const LINKEDIN_URL = 'https://www.linkedin.com/in/jefersonribeirogomes/';
    const TRAILHEAD_URL = 'https://www.salesforce.com/trailblazer/profile';
    function showProfileOnMonitor(mode) {
      if (monitorState !== 'normal') {
        notify({ type: 'danger', title: 'Monitor indisponível', description: 'Apague o incêndio ou reinicie a partida primeiro.' });
        return;
      }
      monitorProfileMode = mode;
      updateMonitorScreen();
      setCameraMode('iso');
      showCarSpeech(mode === 'linkedin' ? 'Olha o currículo do papai!' : 'Agentblazer Champion!', 2600);
      progressAchievement('islandActions', 1);
    }
    function openExternal(url) { window.open(url, '_blank', 'noopener'); }

    // Pin de interação (anel + diamante do mapa do DS) para os itens da mesa
    function createInteractivePin(x, y, z) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.95, 40),
        new THREE.MeshBasicMaterial({ color: 0xffceca, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, y + 0.05, z);
      scene.add(ring);
      const diamond = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.85),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffceca, emissiveIntensity: 0.55, roughness: 0.3 })
      );
      diamond.scale.y = 1.35;
      diamond.position.set(x, y + 3, z);
      scene.add(diamond);
      return { ring, diamond, baseY: y };
    }

    const deskInteractives = [
      {
        id: 'radio', name: 'Rádio do Jheff', point: [-50.3, -9.8], y: 0.14,
        text: 'O rádio da mesa toca as músicas do canal oficial do papai no YouTube Music. Aperte play e curta!',
        actions: [
          { label: '▶ Tocar música', run: playRadio },
          { label: 'Abrir canal ↗', run: () => openExternal(RADIO_CHANNEL_URL) }
        ]
      },
      {
        id: 'laptop', name: 'Notebook do Jheff', point: [-21, 4], y: 0.14,
        text: 'O currículo do Jeferson (Jheff) Gomes: Arquiteto de Soluções de IA, Desenvolvedor Senior MuleSoft e Agentblazer Champion. Escolha o que mostrar no monitor grande:',
        actions: [
          { label: 'LinkedIn no monitor', run: () => showProfileOnMonitor('linkedin') },
          { label: 'Trailhead no monitor', run: () => showProfileOnMonitor('trailhead') },
          { label: 'Abrir LinkedIn ↗', run: () => openExternal(LINKEDIN_URL) },
          { label: 'Abrir Trailhead ↗', run: () => openExternal(TRAILHEAD_URL) }
        ]
      },
      {
        id: 'family', name: 'Papai, Mamãe e Ravi', point: [-36, -50.5], y: 0.14,
        text: 'O quadro mais importante do quarto: o dia em que o Ravi chegou. Papai, Mamãe e Ravi, juntinhos desde o primeiro segundo. ❤',
        actions: [
          { label: '👀 Ver o quadro', run: startFamilyFrameView }
        ]
      }
    ];
    deskInteractives.forEach((it) => { it.pointMeshes = createInteractivePin(it.point[0], it.y, it.point[1]); });
    careerInteractives.forEach((it) => { it.pointMeshes = createInteractivePin(it.point[0], it.y, it.point[1]); });

    function interactiveActions(item) {
      if (item.actions) return item.actions;
      return [{ label: item.action, run: () => performIslandAction(item) }];
    }

    // Objeto segurável mais próximo (para o balão "aperte ... para pegar")
    function nearestGrabbable() {
      if (heldItem || inputBlocked()) return null;
      const carLevel = levelOfY(vehicle.position.y);
      let best = null, bestD = Infinity;
      grabbableItems.forEach((item) => {
        if (!item.group.visible || (item.cableRef && item.cableRef.connected)) return;
        if (levelOfY(item.group.position.y) !== carLevel || (item.obs && item.obs.isFalling)) return;
        const d = Math.hypot(vehicle.position.x - item.group.position.x, vehicle.position.z - item.group.position.z);
        if (d < (item.grabRadius || 5.2) && d < bestD) { bestD = d; best = item; }
      });
      return best;
    }
    function grabKeyLabel() {
      if (htmlEl.classList.contains('is-mode-gamepad')) return 'D-pad ↓';
      if (htmlEl.classList.contains('is-mode-touch')) return 'PEGAR';
      return 'E';
    }
    function placePrompt(el, x, y, z) {
      promptAnchor.set(x, y, z).project(camera);
      if (promptAnchor.z > 1) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = `${(promptAnchor.x * 0.5 + 0.5) * sizes.width}px`;
      el.style.top = `${(-promptAnchor.y * 0.5 + 0.5) * sizes.height}px`;
    }

    function updateInteractives(time) {
      nearestInteractive = null;
      if (!inputBlocked()) {
        const onFloor = vehicle.position.y < -15;
        let best = 4.6;
        const careerHere = careerInteractives.filter(it => it.level === (onFloor ? 'floor' : 'desk'));
        (onFloor ? islands.concat([bowlingInteractive]) : deskInteractives).concat(careerHere).forEach((it) => {
          const d = Math.hypot(vehicle.position.x - it.point[0], vehicle.position.z - it.point[1]);
          if (d < best) { best = d; nearestInteractive = it; }
        });
      }
      deskInteractives.concat(careerInteractives).forEach((it, i) => {
        it.pointMeshes.diamond.rotation.y = time * 1.4 + i;
        it.pointMeshes.diamond.position.y = it.y + 3 + Math.sin(time * 2 + i) * 0.35;
        it.pointMeshes.ring.material.opacity = 0.55 + Math.sin(time * 3 + i) * 0.3;
      });
      // Rádio tocando: ponteiro do dial dança e notas musicais saem dos alto-falantes
      if (radioPlaying) {
        radioParts.tunerNeedle.position.x = 0.45 + Math.sin(time * 1.3) * 1.4;
        if (Math.random() < dtNotes) spawnMusicNote(-54 + (Math.random() - 0.5) * 6, 9, -18 + (Math.random() - 0.5) * 3);
      }
      touchInteractEl.classList.toggle('is-visible', !!nearestInteractive);

      if (nearestInteractive) {
        interactLabelEl.textContent = nearestInteractive.name;
        const baseY = nearestInteractive.y !== undefined ? nearestInteractive.y : ISLAND_Y;
        placePrompt(interactPromptEl, nearestInteractive.point[0], baseY + 5, nearestInteractive.point[1]);
        grabPromptEl.style.display = 'none';
        return;
      }
      interactPromptEl.style.display = 'none';

      const grab = nearestGrabbable();
      if (!grab) { grabPromptEl.style.display = 'none'; return; }
      grabPromptEl.innerHTML = `Aperte <span class="key">${grabKeyLabel()}</span> para pegar`;
      const dims = grab.group.userData.dims;
      placePrompt(grabPromptEl, grab.group.position.x, grab.group.position.y + (dims ? dims.h : 2.2) + 1.2, grab.group.position.z);
    }
    const dtNotes = 0.04;

    function interactWithNearest() {
      if (!nearestInteractive || inputBlocked()) return;
      if (nearestInteractive.careerIndex !== undefined) { openCareerBoard(nearestInteractive.careerIndex); return; }
      currentIsland = nearestInteractive;
      currentActions = interactiveActions(currentIsland);
      islandModalTitle.textContent = currentIsland.name;
      islandModalText.textContent = currentIsland.text;
      islandActionsEl.innerHTML = '';
      currentActions.forEach((action) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button';
        btn.textContent = action.label;
        const islandHere = currentIsland;
        btn.addEventListener('click', () => {
          closeModals();
          setTimeout(() => action.run(), 120);
          // Conquista secreta: interagir com todas as ilhas do quarto
          if (islands.includes(islandHere)) trackAchievementSet('allIslands', islandHere.id);
        });
        islandActionsEl.appendChild(btn);
      });
      openModalPanel('island');
      rumble(0.15, 0.3, 80);
    }
    // Enter / ✕ dentro do modal executa a primeira ação
    function runPrimaryIslandAction() {
      const first = islandActionsEl.querySelector('button');
      if (first) first.click();
    }
    document.getElementById('island-close').addEventListener('click', closeModals);

    // ============================================================================
    // INTERAÇÃO POR CURSOR (padrão Bruno Simon): raycast só numa LISTA FIXA de hitboxes invisíveis,
    // cursor "pointer" no hover e animações cartoon com GSAP (squash & stretch). Clicar abre o painel
    // do item direto — útil para quem quer ver o currículo sem dirigir até cada portal.
    // ============================================================================
    const pointerHitboxes = [];          // única lista testada pelo raycaster (nada de scene.children)
    const pointerRaycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let pointerInside = false, pointerDirty = false, hoveredHit = null;
    const hitboxMat = new THREE.MeshBasicMaterial({ visible: false }); // não é desenhada, mas o raycast enxerga
    function registerPointerTarget(item, anchor, radius, visual) {
      const box = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), hitboxMat);
      box.userData.item = item;
      box.userData.visual = visual || anchor;
      box.userData.anchor = anchor;
      scene.add(box);
      pointerHitboxes.push(box);
      return box;
    }
    // Objetos dos marcos de carreira (grandes) + pontos de evento (diamantes) da mesa, das ilhas e do boliche
    careerInteractives.forEach((it) => registerPointerTarget(it, it.object, 6.5));
    deskInteractives.concat(careerInteractives, islands, [bowlingInteractive]).forEach((it) => {
      if (it.pointMeshes && it.pointMeshes.diamond) registerPointerTarget(it, it.pointMeshes.diamond, 2.6);
    });
    function syncPointerHitboxes() {
      for (let i = 0; i < pointerHitboxes.length; i++) {
        const h = pointerHitboxes[i];
        h.userData.anchor.getWorldPosition(h.position);
        if (h.userData.anchor === h.userData.item.object) h.position.y += 4; // centro do objeto, não a base
        h.updateMatrixWorld();
      }
    }
    // Squash & stretch: entra esticando com back.out; sai voltando com power2.out
    function hoverAnim(visual, on) {
      if (typeof gsap === 'undefined' || !visual) return;
      const base = visual.userData.baseScale || (visual.userData.baseScale = visual.scale.clone());
      gsap.killTweensOf(visual.scale);
      if (on) gsap.to(visual.scale, { x: base.x * 0.92, y: base.y * 1.14, z: base.z * 0.92, duration: 0.35, ease: 'back.out(3)' });
      else gsap.to(visual.scale, { x: base.x, y: base.y, z: base.z, duration: 0.25, ease: 'power2.out' });
    }
    function clickAnim(visual) {
      if (typeof gsap === 'undefined' || !visual) return;
      const base = visual.userData.baseScale || (visual.userData.baseScale = visual.scale.clone());
      gsap.killTweensOf(visual.scale);
      gsap.timeline()
        .to(visual.scale, { x: base.x * 1.18, y: base.y * 0.78, z: base.z * 1.18, duration: 0.09, ease: 'power2.out' })
        .to(visual.scale, { x: base.x, y: base.y, z: base.z, duration: 0.45, ease: 'back.out(4)' });
    }
    function pointerBlocked() {
      return introActive || menuOpen || !!modalsOpen || devModeActive || isFreeCameraActive;
    }
    function pickHitbox() {
      pointerRaycaster.setFromCamera(pointerNdc, camera);
      const hits = pointerRaycaster.intersectObjects(pointerHitboxes, false);
      return hits.length ? hits[0].object : null;
    }
    function setHovered(h) {
      if (h === hoveredHit) return;
      if (hoveredHit) hoverAnim(hoveredHit.userData.visual, false);
      hoveredHit = h;
      if (hoveredHit) hoverAnim(hoveredHit.userData.visual, true);
      renderer.domElement.style.cursor = hoveredHit ? 'pointer' : '';
    }
    renderer.domElement.addEventListener('pointermove', (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      pointerInside = e.pointerType === 'mouse';
      pointerDirty = true;
    });
    renderer.domElement.addEventListener('pointerleave', () => { pointerInside = false; setHovered(null); });
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (pointerBlocked() || e.button > 0) return;
      const r = renderer.domElement.getBoundingClientRect();
      pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      syncPointerHitboxes();
      const h = pickHitbox();
      if (!h) return;
      clickAnim(h.userData.visual);
      openInteractiveFromPointer(h.userData.item);
    });
    // Abre o painel do item como se o carrinho estivesse ao lado dele
    function openInteractiveFromPointer(item) {
      if (item.careerIndex !== undefined) { openCareerBoard(item.careerIndex); return; }
      const prev = nearestInteractive;
      nearestInteractive = item;
      interactWithNearest();
      nearestInteractive = prev;
    }
    // Chamado pelo loop principal: só faz raycast quando o mouse mexeu (ou a cada ~0,2 s com a câmera andando)
    let pointerTick = 0;
    function updatePointerInteraction(dt) {
      if (!pointerInside || pointerBlocked()) { if (hoveredHit) setHovered(null); return; }
      pointerTick += dt;
      if (!pointerDirty && pointerTick < 0.2) return;
      pointerDirty = false; pointerTick = 0;
      syncPointerHitboxes();
      setHovered(pickHitbox());
    }

    // Sombras: objetos minúsculos (teclas soltas, parafusos, LEDs…) não projetam sombra perceptível,
    // mas cada um seria desenhado de novo no passe de sombra. Roda depois que os modelos carregam.
    function pruneTinyShadowCasters() {
      const s = new THREE.Vector3();
      let pruned = 0;
      scene.traverse((o) => {
        if (!o.isMesh || !o.castShadow || o.isInstancedMesh) return;
        for (let p = o; p; p = p.parent) if (p === vehicle) return; // o carrinho sempre faz sombra
        const g = o.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        o.getWorldScale(s);
        // Peças com menos de ~0,8 de raio quase não aparecem na sombra, mas cada uma custa uma chamada no passe de sombra
        if (g.boundingSphere.radius * Math.max(s.x, s.y, s.z) < 0.8) { o.castShadow = false; pruned++; }
      });
      return pruned;
    }

    // ============================================================================
    // OBJETOS QUEBRÁVEIS (alimentos e plantinhas, mesma mecânica dos controles)
    // ============================================================================
    const breakableObjects = [];
    const BREAK_PRESETS = {
      food: { perStage: 3, colors: [0xd18f45, 0x5a321f, 0xffc23d, 0xe2412f, 0x6cc04a], label: 'mordida' },
      plant: { perStage: 4, colors: [0x48b874, 0x2d6a2f, 0x8a5a2b, 0xa7e05a, 0xffffff], label: 'folhagem' }
    };
    function setupBreakable(obs, group, kind, visual) {
      if (!obs || obs.breakable) return;
      const preset = BREAK_PRESETS[kind];
      const target = visual || group.children[0] || group;
      obs.breakable = {
        kind, hits: 0, stage: 0, lastHit: 0, perStage: preset.perStage, colors: preset.colors,
        group, target, origScale: target.scale.clone(), origR: obs.r, origName: obs.name
      };
      breakableObjects.push(obs);
    }
    function hitBreakable(obs, impact) {
      const b = obs.breakable;
      const now = performance.now();
      if (b.stage >= 4 || now - b.lastHit < 240 || impact < 0.04) return;
      b.lastHit = now;
      b.hits++;
      showCarSpeech(breakSpeechToggle ? 'eita' : 'ops', 1500);
      breakSpeechToggle = !breakSpeechToggle;
      rumble(0.25, 0.45, 90);
      const name = (b.origName || 'Objeto').split('(')[0].trim();
      if (b.hits % b.perStage !== 0) {
        setStatusBanner(`💥 ${name}: ${b.hits % b.perStage}/${b.perStage} batidas para quebrar a parte ${b.stage + 1}/4`, '#ffb300');
        return;
      }
      b.stage++;
      const gp = b.group.getWorldPosition(new THREE.Vector3());
      for (let i = 0; i < 6; i++) {
        const piece = new THREE.Mesh(
          new THREE.BoxGeometry(0.3 + Math.random() * 0.25, 0.16, 0.3 + Math.random() * 0.25),
          new THREE.MeshStandardMaterial({ color: b.colors[i % b.colors.length], roughness: 0.6 })
        );
        const a = Math.random() * Math.PI * 2, dist = 1.2 + Math.random() * 2.4;
        piece.position.set(gp.x + Math.cos(a) * dist, surfaceBaseY(gp.y) + 0.2, gp.z + Math.sin(a) * dist);
        piece.rotation.set(Math.random(), Math.random(), Math.random());
        piece.castShadow = true;
        (gp.y > -15 ? deskWorld : bedroomWorld).add(piece);
        controllerDebrisList.push(piece);
        spawnFx(gp.x, gp.y + 1.5, gp.z, Math.cos(a) * 4, 6 + Math.random() * 4, Math.sin(a) * 4, b.colors[i % b.colors.length], 0.9, 18, 0.8);
      }
      const k = 1 - b.stage * 0.18;
      b.target.scale.set(b.origScale.x * k, b.origScale.y * k, b.origScale.z * k);
      b.target.rotation.z = (b.stage % 2 ? 1 : -1) * 0.12 * b.stage;
      if (b.kind === 'plant') burstLeaves(8);
      if (b.stage >= 4) {
        if (b.kind === 'food') {
          b.group.visible = false;
          obs.r = 0.001;
          setStatusBanner(`🍔 ${name} virou farelo!`, '#ff5722');
        } else {
          b.target.visible = false;
          setStatusBanner(`🪴 ${name} ficou só no vaso!`, '#ff5722');
        }
        logInteractionEvent(`🚨 ${name}: totalmente quebrado(a)!`);
      } else {
        setStatusBanner(`🚨 ${name}: parte ${b.stage}/4 quebrada!`, '#f44336');
        logInteractionEvent(`🚨 ${name}: parte ${b.stage}/4 quebrada`);
      }
      obs.name = `${b.origName} — PARTE ${b.stage}/4`;
    }
    function resetBreakables() {
      breakableObjects.forEach((obs) => {
        const b = obs.breakable;
        b.hits = 0; b.stage = 0;
        b.target.scale.copy(b.origScale);
        b.target.rotation.z = 0;
        b.target.visible = true;
        b.group.visible = true;
        obs.r = b.origR;
        obs.name = b.origName;
      });
    }
    // Plantinhas da mesa (com folhagem própria) quebram igual aos controles
    growablePlants.forEach((p) => {
      if (p.obs && p.group && p.foliageGroup) setupBreakable(p.obs, p.group, 'plant', p.foliageGroup);
    });

    // ============================================================================
    // CIRCUITO: CRONÔMETRO, PORTAIS EM ORDEM, CONTAGEM REGRESSIVA E RANKING LOCAL
    // ============================================================================
    const raceHudTimeEl = document.getElementById('race-time');
    const raceHudCpEl = document.getElementById('race-cp');
    const raceCountdownEl = document.getElementById('race-countdown');
    const circuitEndModalEl = document.getElementById('circuit-end-modal');
    const circuitEndTimeEl = document.getElementById('circuit-end-time');
    const circuitNameForm = document.getElementById('circuit-name-form');
    const circuitNameInput = document.getElementById('circuit-name-input');
    const LEADERBOARD_KEY = 'fire_engine_leaderboard_v1';
    let raceState = 'idle';          // 'idle' | 'countdown' | 'racing'
    let raceStartMs = 0;
    let raceNextGate = 1;
    let raceStartArmed = true;
    let lastLapMs = 0;
    let lastLapSaved = false;
    let countdownTimers = [];
    let leaderboard = [];
    try { leaderboard = JSON.parse(localStorage.getItem(LEADERBOARD_KEY) || '[]'); } catch (e) { leaderboard = []; }
    if (!Array.isArray(leaderboard)) leaderboard = [];

    function formatRaceTime(ms) {
      const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(x).padStart(3, '0')}`;
    }
    function renderLeaderboard(highlight) {
      const tbody = document.querySelector('#leaderboard tbody');
      tbody.innerHTML = '';
      const board = lapBoard();
      board.slice(0, 10).forEach((entry, i) => {
        const tr = document.createElement('tr');
        if (entry === highlight || (highlight && entry.name === highlight.name && Math.round(entry.time) === Math.round(highlight.time)) || entry.mine) tr.className = 'is-new';
        tr.innerHTML = `<td>${i + 1}</td><td></td><td>${formatRaceTime(entry.time)}</td>`;
        tr.children[1].textContent = entry.name;
        tbody.appendChild(tr);
      });
      document.getElementById('leaderboard-container').classList.toggle('has-no-score', board.length === 0);
      const scopeEl = document.getElementById('leaderboard-scope');
      if (scopeEl) scopeEl.textContent = (globalLaps && globalLaps.length) ? '🌎 Ranking global' : '📱 Recordes deste aparelho';
      drawNotebooks();
    }

    function gateIsNear(gate) {
      const p = vehicle.position;
      return Math.hypot(p.x - gate.x, p.z - gate.z) < TRACK_WIDTH * 0.8 && Math.abs(p.y - gate.y) < 4;
    }
    function beginRace() {
      raceState = 'racing';
      raceStartMs = performance.now();
      raceNextGate = 1;
      raceStartArmed = false;
      htmlEl.classList.add('is-racing');
      raceHudCpEl.textContent = `Portal 0 / ${raceGates.length - 1}`;
      logInteractionEvent('🏁 Volta iniciada no Circuito do Ravi!');
    }
    function endRace(silent) {
      countdownTimers.forEach(clearTimeout);
      countdownTimers = [];
      raceCountdownEl.textContent = '';
      raceState = 'idle';
      htmlEl.classList.remove('is-racing');
      if (!silent) notify({ type: 'info', title: 'Corrida encerrada', duration: 2200 });
    }
    function finishLap() {
      lastLapMs = performance.now() - raceStartMs;
      lastLapSaved = false;
      raceState = 'idle';
      raceStartArmed = false;
      htmlEl.classList.remove('is-racing');
      const qualifies = leaderboard.length < 10 || lastLapMs < leaderboard[leaderboard.length - 1].time;
      circuitEndTimeEl.textContent = formatRaceTime(lastLapMs);
      circuitEndModalEl.classList.toggle('is-top-10', qualifies);
      circuitNameForm.classList.remove('is-valide');
      circuitNameInput.value = '';
      openModalPanel('circuit-end');
      sfx('finish', { vol: 0.7, vary: 0 });
      if (qualifies) setTimeout(() => circuitNameInput.focus(), 350);
      confettiBurst(vehicle.position.x, vehicle.position.y + 2, vehicle.position.z, 60);
      unlockAchievement('racer');
      if (lastLapMs < 75000) unlockAchievement('speedster');
      logInteractionEvent(`🏁 Volta completa em ${formatRaceTime(lastLapMs)}`);
      rumble(0.6, 0.8, 300);
    }
    function updateRace() {
      const start = raceGates[0];
      if (raceState === 'idle') {
        // Não começa sozinho: ao passar pela largada pergunta se quer correr (mostra os recordes)
        if (!gateIsNear(start)) raceStartArmed = true;
        else if (raceStartArmed && !inputBlocked()) { raceStartArmed = false; openRaceInvite(); }
        // Fora da corrida, passar por baixo de um portal abre o marco de carreira correspondente
        // (uma vez por passagem: precisa sair do portal para armar de novo)
        for (let i = 1; i < raceGates.length; i++) {
          const g = raceGates[i];
          if (!gateIsNear(g)) { g.careerArmed = true; continue; }
          if (g.careerArmed !== false && !inputBlocked() && CAREER_MILESTONES[i - 1]) {
            g.careerArmed = false;
            carSpeed *= 0.35;
            openCareerBoard(i - 1);
          }
        }
        return;
      }
      if (raceState !== 'racing') return;
      raceHudTimeEl.textContent = formatRaceTime(performance.now() - raceStartMs);
      if (raceNextGate < raceGates.length) {
        if (gateIsNear(raceGates[raceNextGate])) {
          raceNextGate++;
          raceHudCpEl.textContent = `Portal ${raceNextGate - 1} / ${raceGates.length - 1}`;
          if (!sfx('checkpoint', { vol: 0.55, vary: 0 })) { playTone(880, 0, 0.12, 'square', 0.05); }
          rumble(0.2, 0.4, 90);
        }
      } else if (gateIsNear(start)) {
        finishLap();
      }
    }
    function updateGateGlow(time) {
      raceGates.forEach((g, i) => {
        const isNext = raceState === 'racing' ? i === (raceNextGate % raceGates.length) : g.isStart;
        g.postMat.emissiveIntensity = isNext ? 0.55 + Math.sin(time * 6) * 0.35 : 0.12;
      });
    }

    // Leva o carrinho para o grid de largada e faz a contagem 3-2-1
    function placeOnStartGrid() {
      const f = trackFrameAt(START_SAMPLE - 12);
      teleportVehicle({ name: 'Largada', x: f.s.x, z: f.s.z, angle: Math.atan2(f.tx, f.tz), silent: true });
    }
    function startRaceCountdown() {
      if (introActive) return;
      endRace(true);
      if (menuOpen) closeMenu();
      if (modalsOpen) closeModals();
      placeOnStartGrid();
      setCameraMode('close');
      raceState = 'countdown';
      ['3', '2', '1', 'Já!'].forEach((label, i) => {
        countdownTimers.push(setTimeout(() => {
          raceCountdownEl.textContent = label;
          raceCountdownEl.classList.remove('is-pop');
          void raceCountdownEl.offsetWidth;
          raceCountdownEl.classList.add('is-pop');
          if (!sfx(i < 3 ? 'countTick' : 'countGo', { vol: 0.6, vary: 0 })) { playTone(i < 3 ? 440 : 880, 0, i < 3 ? 0.18 : 0.4, 'square', 0.06); }
          if (i === 3) beginRace();
        }, i * 900));
      });
      countdownTimers.push(setTimeout(() => { raceCountdownEl.textContent = ''; }, 3 * 900 + 900));
    }
    // ---------- Mural dos marcos de carreira ----------
    let careerIndex = 0;
    const careerThumbsEl = document.getElementById('career-thumbs');
    CAREER_MILESTONES.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'career-thumb';
      b.style.setProperty('--career-color', m.color);
      b.innerHTML = `<span>${m.emoji}</span><span class="lbl"></span>`;
      b.querySelector('.lbl').textContent = m.label;
      b.setAttribute('aria-label', `Portal ${m.portal}: ${m.company}`);
      b.addEventListener('click', () => showCareerMilestone(i));
      careerThumbsEl.appendChild(b);
    });
    function showCareerMilestone(i) {
      careerIndex = (i + CAREER_MILESTONES.length) % CAREER_MILESTONES.length;
      const m = CAREER_MILESTONES[careerIndex];
      document.getElementById('career-title').textContent = m.title;
      document.getElementById('career-pill').textContent = `${m.company} · ${m.period}`;
      document.getElementById('career-emoji').textContent = m.emoji;
      document.getElementById('career-portal').textContent = `Portal ${m.portal}`;
      document.getElementById('career-art').style.setProperty('--career-color', m.color);
      document.getElementById('career-role').textContent = m.role;
      document.getElementById('career-meta').textContent = `${m.company} · ${m.place}`;
      document.getElementById('career-intro').textContent = m.intro;
      const ul = document.getElementById('career-bullets');
      ul.innerHTML = '';
      m.bullets.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      const tags = document.getElementById('career-tags');
      tags.innerHTML = '';
      m.tags.forEach((t) => { const s = document.createElement('span'); s.textContent = t; tags.appendChild(s); });
      careerThumbsEl.querySelectorAll('.career-thumb').forEach((el, k) => el.classList.toggle('is-active', k === careerIndex));
      playTone(520 + careerIndex * 40, 0, 0.08, 'triangle', 0.04);
    }
    let careerOpenedAt = 0;
    function openCareerBoard(i) {
      careerOpenedAt = performance.now();
      showCareerMilestone(i);
      openModalPanel('career');
      const m = CAREER_MILESTONES[careerIndex];
      logInteractionEvent(`🏆 Marco de carreira: Portal ${m.portal} · ${m.company}`);
      trackAchievementSet('career', 'p' + m.portal);
      rumble(0.15, 0.3, 80);
    }
    document.getElementById('career-prev').addEventListener('click', () => showCareerMilestone(careerIndex - 1));
    document.getElementById('career-next').addEventListener('click', () => showCareerMilestone(careerIndex + 1));
    document.getElementById('career-close').addEventListener('click', closeModals);
    // Setas do teclado trocam o marco com o mural aberto
    window.addEventListener('keydown', (e) => {
      if (modalsOpen !== 'career') return;
      if (e.key === 'ArrowLeft') { showCareerMilestone(careerIndex - 1); e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { showCareerMilestone(careerIndex + 1); e.preventDefault(); return; }
      // Qualquer outra tecla (acelerar, pular, Esc, espaço...) fecha o mural e volta ao jogo
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key) || e.repeat || performance.now() - careerOpenedAt < 700) return;
      e.preventDefault();
      closeModals();
    });
    // Toque em qualquer botão do controle na tela também fecha o mural
    document.addEventListener('pointerdown', (e) => {
      if (modalsOpen === 'career' && performance.now() - careerOpenedAt > 700 && e.target.closest('.touch-pad, .touch-steer, .touch-buttons')) closeModals();
    }, true);

    function openRaceInvite() {
      const list = document.getElementById('race-invite-records');
      list.innerHTML = '';
      const board = lapBoard();
      if (!board.length) {
        const li = document.createElement('li');
        li.className = 'is-empty';
        li.textContent = 'Nenhum recorde ainda — seja o primeiro!';
        list.appendChild(li);
      } else {
        board.slice(0, 5).forEach((e, i) => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="pos">${['🥇', '🥈', '🥉'][i] || (i + 1) + 'º'}</span><span class="name"></span><span class="time">${formatRaceTime(e.time)}</span>`;
          li.querySelector('.name').textContent = e.name;
          list.appendChild(li);
        });
      }
      carSpeed *= 0.3;
      openModalPanel('race-invite');
      playTone(660, 0, 0.1, 'triangle', 0.05); playTone(880, 0.1, 0.16, 'triangle', 0.05);
    }
    document.getElementById('race-invite-go').addEventListener('click', () => { closeModals(); setTimeout(startRaceCountdown, 150); });
    document.getElementById('race-invite-no').addEventListener('click', closeModals);
    document.getElementById('race-invite-close').addEventListener('click', closeModals);
    document.getElementById('race-btn-start').addEventListener('click', startRaceCountdown);
    document.getElementById('race-btn-end').addEventListener('click', () => { endRace(); closeMenu(); });
    document.getElementById('circuit-end-again').addEventListener('click', startRaceCountdown);
    document.getElementById('circuit-end-close').addEventListener('click', closeModals);
    circuitNameInput.addEventListener('input', () => {
      circuitNameInput.value = circuitNameInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
      circuitNameForm.classList.toggle('is-valide', circuitNameInput.value.length === 3);
    });
    circuitNameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (lastLapSaved || circuitNameInput.value.length !== 3) return;
      const entry = { name: circuitNameInput.value, time: Math.round(lastLapMs), date: Date.now() };
      leaderboard.push(entry);
      leaderboard.sort((a, b) => a.time - b.time);
      leaderboard = leaderboard.slice(0, 10);
      try { localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(leaderboard)); } catch (err) { /* ignora */ }
      lastLapSaved = true;
      setPlayerTag(entry.name);
      renderLeaderboard(entry);
      closeModals();
      openMenu('circuit');
      notify({ type: 'success', title: 'Recorde salvo!', description: `${entry.name} · ${formatRaceTime(entry.time)}` });
      cloudSubmitLap(entry.name, entry.time);
    });

    // ============================================================================
    // CONTA E NUVEM (login com Google + Firestore) — opcional, nunca bloqueia o jogo
    // ============================================================================
    const TAG_STORAGE_KEY = 'fire_engine_tag_v1';
    let playerTag = null;
    try { playerTag = localStorage.getItem(TAG_STORAGE_KEY); } catch (e) { /* ignora */ }
    function setPlayerTag(tag) {
      if (!/^[A-Z0-9]{3}$/.test(tag || '')) return;
      playerTag = tag;
      try { localStorage.setItem(TAG_STORAGE_KEY, tag); } catch (e) { /* ignora */ }
      scheduleCloudSave();
    }
    let globalLaps = null, globalBowlingTop = 0, cloudUid = null, cloudSaveTimer = null, cloudApplying = false;
    function getCloud() { return window.cloud || null; }
    function cloudSignedIn() { const c = getCloud(); return !!(c && c.enabled && c.user); }
    // Ranking exibido: global (quando a nuvem está ativa) ou o deste aparelho
    function lapBoard() { return globalLaps && globalLaps.length ? globalLaps : leaderboard; }

    function localProfile() {
      return {
        tag: playerTag || undefined,
        paint: achievementState.paint,
        custom: achievementState.custom || undefined,
        bestLapMs: leaderboard.length ? Math.round(leaderboard[0].time) : undefined,
        bowlingBest: bowlingBest || undefined,
        achievements: { unlocked: achievementState.unlocked, progress: achievementState.progress, sets: achievementState.sets }
      };
    }
    function scheduleCloudSave() {
      if (cloudApplying || !cloudSignedIn()) return;
      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = setTimeout(() => {
        const c = getCloud();
        if (c && c.user && c.saveProfile) c.saveProfile(localProfile()).catch((e) => console.warn('[cloud] save', e));
      }, 2500);
    }
    // Junta o progresso da conta com o deste aparelho (fica sempre com o melhor de cada um)
    function mergeRemoteProfile(remote) {
      if (!remote) return;
      cloudApplying = true;
      const a = remote.achievements || {};
      Object.entries(a.unlocked || {}).forEach(([k, v]) => { if (!achievementState.unlocked[k]) achievementState.unlocked[k] = v; });
      Object.entries(a.progress || {}).forEach(([k, v]) => { achievementState.progress[k] = Math.max(achievementState.progress[k] || 0, v); });
      Object.entries(a.sets || {}).forEach(([k, v]) => { achievementState.sets[k] = [...new Set([...(achievementState.sets[k] || []), ...v])]; });
      if (remote.paint) achievementState.paint = remote.paint;
      if (remote.custom) achievementState.custom = Object.assign({}, achievementState.custom || {}, remote.custom);
      if (remote.tag && !playerTag) { playerTag = remote.tag; try { localStorage.setItem(TAG_STORAGE_KEY, playerTag); } catch (e) { /* ignora */ } }
      if (remote.bowlingBest > bowlingBest) {
        bowlingBest = remote.bowlingBest;
        try { localStorage.setItem(BOWLING_BEST_KEY, String(bowlingBest)); } catch (e) { /* ignora */ }
        drawBowlingBoard();
      }
      if (remote.bestLapMs && !leaderboard.some(e => Math.round(e.time) === remote.bestLapMs)) {
        leaderboard.push({ name: remote.tag || 'EU', time: remote.bestLapMs, date: Date.now() });
        leaderboard.sort((x, y) => x.time - y.time);
        leaderboard = leaderboard.slice(0, 10);
        try { localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(leaderboard)); } catch (e) { /* ignora */ }
      }
      saveAchievements();
      applyPaint(achievementState.paint);
      if (typeof applyCarCustom === 'function') applyCarCustom();
      renderAchievements();
      renderLeaderboard();
      cloudApplying = false;
    }
    async function refreshGlobalBoards() {
      const c = getCloud();
      if (!c || !c.enabled) return;
      try {
        globalLaps = await c.topLaps(10);
        const top = await c.topBowling(1);
        globalBowlingTop = top.length ? top[0].score : 0;
        window.__globalBowlingTop = globalBowlingTop;
        renderLeaderboard();
        drawBowlingBoard();
      } catch (e) { console.warn('[cloud] ranking', e); }
    }
    function cloudSubmitLap(tag, time) {
      const c = getCloud();
      if (!cloudSignedIn()) return;
      c.submitLap(tag, time).then((improved) => {
        if (improved) notify({ type: 'success', title: 'Ranking global', description: 'Sua melhor volta foi publicada!' });
        refreshGlobalBoards();
      }).catch((e) => console.warn('[cloud] lap', e));
      scheduleCloudSave();
    }
    function cloudSubmitBowling(score) {
      const c = getCloud();
      if (!cloudSignedIn()) return;
      c.submitBowling(playerTag || 'JOG', score).then(() => refreshGlobalBoards()).catch((e) => console.warn('[cloud] bowling', e));
      scheduleCloudSave();
    }

    // Interface da conta (menu inicial)
    const accStatusEl = document.getElementById('account-status');
    const accSignInEl = document.getElementById('account-signin');
    const accSignOutEl = document.getElementById('account-signout');
    const accDeleteEl = document.getElementById('account-delete');
    let deleteArmedUntil = 0;
    function renderAccount() {
      const c = getCloud();
      const signed = cloudSignedIn();
      accSignInEl.hidden = signed;
      accSignOutEl.hidden = !signed;
      accDeleteEl.hidden = !signed;
      accSignInEl.disabled = !(c && c.enabled);
      document.getElementById('recaptcha-note').hidden = !(c && c.appCheckEnabled);
      accSignInEl.classList.toggle('is-disabled', !(c && c.enabled));
      if (!c || !c.ready) accStatusEl.textContent = 'Conectando…';
      else if (c.error) accStatusEl.textContent = c.error;
      else if (!c.enabled) accStatusEl.textContent = 'Ranking online em breve. Por enquanto seu progresso fica salvo neste aparelho.';
      else if (!signed) accStatusEl.textContent = 'Entre para guardar recordes e conquistas em qualquer aparelho e aparecer no ranking global.';
      else accStatusEl.textContent = `Olá, ${c.user.name}! Seu progresso está sincronizado${playerTag ? ` como ${playerTag}` : ''}.`;
      // Tela inicial: botão "Entrar com Google" (só com a nuvem ativa) ou "Conectado como …"
      const introAcc = document.getElementById('intro-account');
      if (introAcc) {
        introAcc.hidden = !(c && c.ready && c.enabled);
        document.getElementById('intro-signin').hidden = signed;
        document.getElementById('intro-account-status').textContent = signed ? `Conectado como ${c.user.name} ✓` : 'Opcional: guarda seus recordes na nuvem';
      }
    }
    accSignInEl.addEventListener('click', () => doCloudSignIn());
    document.getElementById('intro-signin').addEventListener('click', (e) => { e.stopPropagation(); doCloudSignIn(); });
    async function doCloudSignIn() {
      const c = getCloud();
      if (!c || !c.enabled) return;
      try { await c.signIn(); }
      catch (e) {
        const code = (e && e.code) || 'erro-desconhecido';
        console.warn('[cloud] signIn', code, e && e.message);
        const hints = {
          'auth/unauthorized-domain': 'Este endereço não está nos domínios autorizados do Firebase.',
          'auth/operation-not-allowed': 'O login com Google não está ativado no Firebase.',
          'auth/popup-blocked': 'O navegador bloqueou a janela de login.',
          'auth/network-request-failed': 'Falha de rede ao falar com o Google.',
          'auth/internal-error': 'Erro interno do login (verifique as restrições da chave de API).'
        };
        notify({ type: 'danger', title: 'Não foi possível entrar', description: `${hints[code] || 'Tente novamente em instantes.'} (${code})`, duration: 8000 });
      }
    }
    accSignOutEl.addEventListener('click', () => { const c = getCloud(); if (c && c.signOut) c.signOut(); });
    // Exclusão em dois cliques (sem janelas do navegador)
    accDeleteEl.addEventListener('click', async () => {
      const c = getCloud();
      if (!cloudSignedIn()) return;
      if (Date.now() > deleteArmedUntil) {
        deleteArmedUntil = Date.now() + 4000;
        accDeleteEl.textContent = 'Clique de novo para apagar';
        setTimeout(() => { accDeleteEl.textContent = 'Apagar meus dados'; }, 4000);
        return;
      }
      try {
        await c.deleteMyData();
        await c.signOut();
        notify({ type: 'success', title: 'Dados apagados', description: 'Tudo o que estava na sua conta foi removido do servidor.' });
        refreshGlobalBoards();
      } catch (e) { notify({ type: 'danger', title: 'Falha ao apagar', description: 'Tente novamente em instantes.' }); }
    });
    function onCloudChange() {
      const c = getCloud();
      renderAccount();
      if (!c || !c.ready || !c.enabled) return;
      const uid = c.user ? c.user.uid : null;
      if (uid && uid !== cloudUid) {
        cloudUid = uid;
        c.loadProfile().then((remote) => {
          mergeRemoteProfile(remote);
          return c.saveProfile(localProfile());
        }).then(() => {
          // Publica os recordes deste aparelho que ainda não estavam no ranking global
          if (leaderboard.length && playerTag) c.submitLap(playerTag, leaderboard[0].time).catch(() => {});
          if (bowlingBest > 0) c.submitBowling(playerTag || 'JOG', bowlingBest).catch(() => {});
          notify({ type: 'success', title: 'Conta conectada', description: 'Recordes e conquistas sincronizados.' });
          renderAccount();
          refreshGlobalBoards();
        }).catch((e) => console.warn('[cloud] sync', e));
      } else if (!uid) {
        cloudUid = null;
      }
      if (globalLaps === null) refreshGlobalBoards();
    }
    window.addEventListener('cloud-change', onCloudChange);
    renderAccount();
    if (window.cloud) onCloudChange();

    // Pulos: L1/Q = pulinho; △/F = pulo; △/F duas vezes rápido = pulo duplo para a frente (−10% de bateria)
    let lastJumpPressAt = 0;
    let doubleJumpUsed = false;
    function handleJumpPress() {
      const now = performance.now();
      if (carAirborne && !doubleJumpUsed && now - lastJumpPressAt < 420) {
        lastJumpPressAt = 0;
        triggerDoubleJump();
        return;
      }
      lastJumpPressAt = now;
      if (!carAirborne) { doubleJumpUsed = false; triggerCarJump(); }
    }
    function triggerSmallHop() {
      if (carAirborne || isSomersaulting || isFallingOff || inputBlocked()) return;
      launchVehicle(0.2);
      doubleJumpUsed = false;
      rumble(0.2, 0.2, 80);
      if (!sfx('jump', { vol: 0.35, rate: 1.1 })) { playTone(420, 0, 0.06, 'triangle', 0.04); }
    }
    function triggerDoubleJump() {
      if (inputBlocked() || isFallingOff || isSomersaulting) return;
      if (carBattery < 10) { showCarSpeech('Sem energia pro pulo duplo!', 1400); return; }
      carBattery = Math.max(0, carBattery - 10);
      updateBatteryHUD();
      doubleJumpUsed = true;
      // Mesmo efeito do quique, mas para a frente: sobe de novo e ganha embalo
      fallVelocityY = Math.max(fallVelocityY, 0.3);
      carAirPeakY = Math.max(carAirPeakY, vehicle.position.y);
      carSpeed = Math.min(baseMaxSpeed * 1.6, Math.max(carSpeed, 0) + 0.22);
      carBodyGroup.rotation.x = 0.35;
      for (let i = 0; i < 6; i++) spawnTurboSpark();
      showCarSpeech('Pulo duplo!', 1200);
      setStatusBanner(`🦘 Pulo duplo para a frente (−10% de bateria: ${Math.round(carBattery)}%)`, '#35e0ff');
      if (!sfx('jump', { vol: 0.5, rate: 1.3 })) { playTone(600, 0, 0.08, 'triangle', 0.06); playTone(900, 0.06, 0.12, 'triangle', 0.05); }
      rumble(0.35, 0.5, 140);
      progressAchievement('jumper', 1);
    }

    // Acelerador apertado 2x rápido = mini turbo (gasta 10% da bateria)
    let lastAccelTapAt = 0;
    function tapAccelerator() {
      const now = performance.now();
      if (now - lastAccelTapAt < 320) {
        lastAccelTapAt = 0;
        triggerDoubleTapTurbo();
      } else {
        lastAccelTapAt = now;
      }
    }
    function triggerDoubleTapTurbo() {
      if (inputBlocked() || carAirborne || isFallingOff) return;
      if (carBattery < 10) {
        showCarSpeech('Sem energia pro turbo!', 1400);
        return;
      }
      carBattery = Math.max(0, carBattery - 10);
      updateBatteryHUD();
      turboBoostTimer = Math.max(turboBoostTimer, 0.9);
      carSpeed = Math.max(carSpeed, baseMaxSpeed * 1.5);
      for (let i = 0; i < 6; i++) spawnTurboSpark();
      showCarSpeech('⚡ Turbo!', 1000);
      setStatusBanner(`⚡ Mini turbo de toque duplo (−10% de bateria: ${Math.round(carBattery)}%)`, '#35e0ff');
      if (!sfx('nitro', { vol: 0.5, rate: 1.2 })) { playTone(520, 0, 0.08, 'square', 0.05); playTone(780, 0.07, 0.12, 'square', 0.05); }
      rumble(0.3, 0.6, 160);
    }

    // Tecla R / Select: volta para o ponto de largada
    // Destravar: volta para uma posição segura de ~2 s atrás (DS: botão "Unstuck")
    function unstuckCar() {
      if (introActive || isModalOpen) return;
      const spot = safeSpots.length > 3 ? safeSpots[safeSpots.length - 4] : safeSpots[0];
      if (!spot) { respawnAtStart(); return; }
      if (heldItem) releaseHeldItem();
      teleportVehicle({ name: 'Destravar', x: spot.x, z: spot.z, angle: spot.angle, floor: spot.floor, silent: true });
      bajaFlip.active = false; bajaBodyGroup.rotation.set(0, 0, 0); bajaBodyGroup.position.set(0, 0, 0);
      safeSpots.length = 0;
      showCarSpeech('Desvirado! 🔧', 1500);
      setStatusBanner('🔧 Destravado: de volta à última posição segura [U]', '#35e0ff');
    }
    // Respawn: leva ao ponto de viagem rápida mais próximo (DS: "Teleports you to the closest respawn")
    function respawnClosest() {
      if (introActive || isModalOpen) return;
      const p = vehicle.position;
      let best = null, bd = Infinity;
      MAP_LOCATIONS.forEach((l) => { if (l.x === undefined) return; const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; best = l; } });
      if (!best) return;
      if (heldItem) releaseHeldItem();
      teleportVehicle(Object.assign({}, best, { silent: true }));
      showCarSpeech(`Respawn: ${best.name}`, 1600);
    }
    function respawnAtStart() {
      if (introActive || isModalOpen) return;
      if (IS_QUINTAL) { if (heldItem) releaseHeldItem(); teleportVehicle(rallyStartLocation()); showCarSpeech('De volta à largada do rally!', 1600); return; }
      if (raceState !== 'idle') endRace(true);
      if (heldItem) releaseHeldItem();
      teleportVehicle({ name: 'Largada', x: 11.5, z: 11.5, angle: -0.55, silent: true });
      showCarSpeech('De volta à largada!', 1600);
      setStatusBanner('↩️ Carrinho de volta ao ponto de início [R]', '#35e0ff');
    }

    // ============================================================================
    // CADERNOS DA MESA: CONQUISTAS, RECORDES E PINTURAS ESCRITOS À MÃO
    // ============================================================================
    function drawNotebookPage(canvas, title, lines, paper) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = paper === 'white' ? '#fbfbf8' : '#fff1a0';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(30, 80, 190, 0.45)';
      ctx.lineWidth = 2;
      for (let y = 132; y < h; y += 44) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(190, 30, 45, 0.6)';
      ctx.beginPath(); ctx.moveTo(46, 0); ctx.lineTo(46, h); ctx.stroke();
      ctx.fillStyle = '#7a0b0b';
      ctx.font = '700 52px "Amatic SC", sans-serif';
      ctx.fillText(title, 58, 116);
      ctx.font = '700 36px "Amatic SC", sans-serif';
      lines.forEach((line, i) => {
        const y = 166 + i * 44;
        if (y > h - 8) return;
        ctx.fillStyle = line.done ? '#0f5a20' : '#0b1d55';
        ctx.fillText((line.done ? '✔ ' : '○ ') + line.text, 58, y);
        if (line.right) {
          ctx.textAlign = 'right';
          ctx.fillText(line.right, w - 18, y);
          ctx.textAlign = 'left';
        }
      });
    }
    const notebookCanvases = notepadRefs.map((ref) => {
      const make = (mesh, paper) => {
        const c = document.createElement('canvas');
        c.width = 400; c.height = 520;
        const tex = new THREE.CanvasTexture(c);
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        tex.encoding = THREE.sRGBEncoding;
        const base = mesh.material;
        const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
        mesh.material = [base, base, top, base, base, base]; // face +Y da caixa recebe a página
        return { c, tex, paper };
      };
      return { pad: make(ref.pad, 'yellow'), sheet: make(ref.sheet, 'white') };
    });
    function drawNotebooks() {
      if (!notebookCanvases.length) return;
      const achLines = ACHIEVEMENTS.map((a) => {
        const done = !!achievementState.unlocked[a.id];
        const prog = done ? a.total : (achievementState.progress[a.id] || 0);
        return { text: a.secret && !done ? '???' : a.title, done, right: a.total > 1 ? `${prog}/${a.total}` : '' };
      });
      const half = Math.ceil(achLines.length / 2);
      const pages = [
        ['Conquistas', achLines.slice(0, half), notebookCanvases[0] && notebookCanvases[0].pad],
        ['Conquistas (2)', achLines.slice(half), notebookCanvases[0] && notebookCanvases[0].sheet],
        ['Recordes', leaderboard.slice(0, 8).map((e, i) => ({ text: `${i + 1}. ${e.name}`, done: i === 0, right: formatRaceTime(e.time) })), notebookCanvases[1] && notebookCanvases[1].pad],
        ['Pinturas', REWARDS.map(r => ({ text: r.label, done: unlockedCount() >= r.unlockAt, right: unlockedCount() >= r.unlockAt ? '' : `${r.unlockAt}` })), notebookCanvases[1] && notebookCanvases[1].sheet]
      ];
      pages.forEach(([title, lines, page]) => {
        if (!page) return;
        if (!lines.length) lines = [{ text: 'Nenhuma volta ainda!', done: false }];
        drawNotebookPage(page.c, title, lines, page.paper);
        page.tex.needsUpdate = true;
      });
    }
    if (document.fonts && document.fonts.load) {
      document.fonts.load('700 36px "Amatic SC"').then(drawNotebooks).catch(() => {});
    }

    // ============================================================================
    // GAMEPAD (DualSense / Xbox via Gamepad API — mapeamento do DS do Bruno Simon)
    // ✕ interagir/sair · ○ boost · △ pular · ▢ freio · L2 acelerar · R2 ré
    // L1 hidráulica · R1 água · analógico esq. direção · L3 buzina
    // analógico dir. câmera · R3 zoom · Create/Select reiniciar posição · Options menu
    // D-pad ↑ câmera · ↓ pegar/soltar · → mapa
    // ============================================================================
    const padInput = { throttle: 0, reverse: 0, steer: 0, boost: false, brake: false, camX: 0, camY: 0 };
    let padPrevButtons = [];
    let activeGamepadIndex = null;
    let camOrbitYaw = 0, camOrbitPitch = 0;

    function rumble(weak = 0.3, strong = 0.5, duration = 120) {
      const gp = activeGamepadIndex !== null && navigator.getGamepads ? navigator.getGamepads()[activeGamepadIndex] : null;
      const act = gp && gp.vibrationActuator;
      if (act && act.playEffect) act.playEffect('dual-rumble', { duration, weakMagnitude: weak, strongMagnitude: strong }).catch(() => {});
    }
    function setGamepadMode(gp) {
      const isXbox = /xbox|xinput/i.test(gp.id);
      htmlEl.classList.add('is-mode-gamepad');
      htmlEl.classList.remove('is-mode-touch', 'is-mode-mouse-keyboard');
      htmlEl.classList.toggle('is-gamepad-xbox', isXbox);
      htmlEl.classList.toggle('is-gamepad-playstation', !isXbox);
      htmlEl.classList.remove('is-gamepad-default');
    }
    window.addEventListener('gamepadconnected', (e) => {
      activeGamepadIndex = e.gamepad.index;
      notify({ type: 'success', title: 'Controle conectado', description: e.gamepad.id.replace(/\(.*?\)/g, '').trim().slice(0, 40), duration: 3500 });
      const tab = document.querySelector('#controls-tabs .tab[data-tabs-name="gamepad"]');
      if (tab) tab.click();
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === activeGamepadIndex) activeGamepadIndex = null;
      Object.assign(padInput, { throttle: 0, reverse: 0, steer: 0, boost: false, brake: false, camX: 0, camY: 0 });
      htmlEl.classList.remove('is-mode-gamepad');
      htmlEl.classList.add('is-mode-mouse-keyboard');
      notify({ type: 'danger', title: 'Controle desconectado', duration: 3000 });
    });

    const deadzone = (v, d = 0.15) => Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
    function pollGamepad() {
      if (!navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      let gp = activeGamepadIndex !== null ? pads[activeGamepadIndex] : null;
      if (!gp) {
        for (const p of pads) if (p && p.connected) { gp = p; activeGamepadIndex = p.index; break; }
      }
      if (!gp) {
        // Sem controle: zera a entrada (antes os últimos valores ficavam "presos" e o carro andava sozinho)
        Object.assign(padInput, { throttle: 0, reverse: 0, steer: 0, boost: false, brake: false, camX: 0, camY: 0 });
        padPrevButtons = [];
        return;
      }
      const b = (i) => gp.buttons[i] ? gp.buttons[i].value : 0;
      const pressed = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const justPressed = (i) => pressed(i) && !padPrevButtons[i];
      const anyInput = gp.buttons.some(x => x.pressed) || gp.axes.some(a => Math.abs(a) > 0.3);
      if (anyInput && !htmlEl.classList.contains('is-mode-gamepad')) setGamepadMode(gp);

      // Gatilhos analógicos: R2 acelera, L2 dá ré
      padInput.throttle = b(7);
      padInput.reverse = b(6);
      padInput.steer = -deadzone(gp.axes[0] || 0);
      padInput.boost = pressed(1);
      padInput.brake = pressed(2);
      padInput.camX = deadzone(gp.axes[2] || 0);
      padInput.camY = deadzone(gp.axes[3] || 0);
      // R1 segurado = jato d'água contínuo (soltar desliga)
      if (pressed(5) && !inputBlocked()) keys.spray = true;
      else if (padPrevButtons[5] && !pressed(5)) keys.spray = false;

      // Botões de ação (borda de subida)
      if (introActive) {
        if (justPressed(0) || justPressed(9)) startExperience();
      } else if (modalsOpen === 'career') {
        // Mural de carreira: ← → (D-pad/analógico) trocam o marco; acelerar (R2) ou qualquer outro botão fecha
        const lx = deadzone(gp.axes[0] || 0, 0.35);
        const now = performance.now();
        const dirX = (lx > 0.6 || pressed(15)) ? 1 : (lx < -0.6 || pressed(14)) ? -1 : 0;
        if (dirX && now - uiNavLastMove > 320) { uiNavLastMove = now; showCareerMilestone(careerIndex + dirX); }
        if (!dirX) uiNavLastMove = 0;
        const anyButton = [0, 1, 2, 3, 4, 5, 8, 9, 12, 13].some(i => justPressed(i));
        const fresh = performance.now() - careerOpenedAt > 700;
        if (fresh && (anyButton || justPressed(7) || justPressed(6))) closeModals();
      } else if (modalsOpen || menuOpen) {
        // Navegação de interface: analógico esquerdo / D-pad move o foco, ✕ seleciona, ○ volta
        const lx = deadzone(gp.axes[0] || 0, 0.35), ly = deadzone(gp.axes[1] || 0, 0.35);
        const dirX = (lx > 0.5 || pressed(15)) ? 1 : (lx < -0.5 || pressed(14)) ? -1 : 0;
        const dirY = (ly > 0.5 || pressed(13)) ? 1 : (ly < -0.5 || pressed(12)) ? -1 : 0;
        const now = performance.now();
        if (dirX || dirY) {
          if (now - uiNavLastMove > (uiNavHeld ? 170 : 320)) {
            uiNavHeld = uiNavLastMove > 0 && now - uiNavLastMove < 400;
            uiNavLastMove = now;
            moveUiFocus(dirX, dirY);
          }
        } else {
          uiNavLastMove = 0;
          uiNavHeld = false;
        }
        if (justPressed(0)) activateUiFocus();
        if (justPressed(1)) { if (modalsOpen) closeModalFromUser(); else closeMenu(); }
        if (justPressed(9) && menuOpen) closeMenu();
        if (menuOpen) {
          const order = menuNavItems.map(el => el.dataset.name);
          const idx = order.indexOf(currentMenuSection);
          if (justPressed(5)) { selectMenuSection(order[(idx + 1) % order.length]); focusUiElement(menuNavItems[(idx + 1) % order.length]); }
          if (justPressed(4)) { selectMenuSection(order[(idx - 1 + order.length) % order.length]); focusUiElement(menuNavItems[(idx - 1 + order.length) % order.length]); }
        }
      } else {
        // R2 apertado duas vezes rápido = mini turbo
        if (b(7) > 0.6 && padPrevR2 <= 0.6) tapAccelerator();
        if (justPressed(0)) interactWithNearest();
        if (justPressed(3)) handleJumpPress();
        if (justPressed(4)) triggerSmallHop(); // L1: pulinho
        if (justPressed(10)) playHonk();
        if (justPressed(11)) zoomFactor = zoomFactor > 0.85 ? 0.62 : 1.0;
        if (justPressed(8)) respawnAtStart();
        if (justPressed(9)) { openMenu(); focusUiElement(menuNavItems.find(el => el.classList.contains('is-active'))); }
        if (justPressed(12)) cycleCameraMode();
        if (justPressed(13)) toggleGrabItem();
        if (justPressed(15)) openMap();
      }
      padPrevButtons = gp.buttons.map(x => x.pressed);
      padPrevR2 = b(7);
    }
    let padPrevR2 = 0;

    // ---------- Foco de interface navegável pelo controle (menu, modais e mapa) ----------
    let uiFocusEl = null, uiNavLastMove = 0, uiNavHeld = false;
    function uiFocusables() {
      let root = null;
      if (modalsOpen) root = document.querySelector('#modals .modal.is-displayed');
      else if (menuOpen) root = document.querySelector('#menu .inner');
      if (!root) return [];
      const list = [...root.querySelectorAll('button, a.button, a.radio-link, .location, input.input-text')];
      return list.filter((el) => {
        // Seções escondidas do MENU (abas) ficam de fora; nos painéis (.modal .content) todos os botões valem
        if (el.disabled || el.closest('#menu .content:not(.is-visible)') || el.closest('.tabs-content-item:not(.is-active)')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      });
    }
    function focusUiElement(el) {
      if (uiFocusEl) uiFocusEl.classList.remove('gp-focus');
      uiFocusEl = el || null;
      if (!uiFocusEl) return;
      uiFocusEl.classList.add('gp-focus');
      uiFocusEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Focar um ícone do topo do menu já abre a seção correspondente
      if (uiFocusEl.matches('#menu-navigation .item')) selectMenuSection(uiFocusEl.dataset.name);
      if (uiFocusEl.matches('.location')) uiFocusEl.classList.add('is-hover');
    }
    function moveUiFocus(dx, dy) {
      const items = uiFocusables();
      if (!items.length) return;
      if (!uiFocusEl || !items.includes(uiFocusEl)) { focusUiElement(items[0]); return; }
      document.querySelectorAll('.location.is-hover').forEach(l => l.classList.remove('is-hover'));
      const a = uiFocusEl.getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      let best = null, bestScore = Infinity;
      items.forEach((el) => {
        if (el === uiFocusEl) return;
        const r = el.getBoundingClientRect();
        const vx = r.left + r.width / 2 - ax, vy = r.top + r.height / 2 - ay;
        const along = vx * dx + vy * dy;          // distância na direção pedida
        if (along <= 4) return;
        const across = Math.abs(dx ? vy : vx);      // desvio lateral pesa mais
        const score = along + across * 2.2;
        if (score < bestScore) { bestScore = score; best = el; }
      });
      if (best) { focusUiElement(best); if (!sfx('uiMove', { vol: 0.3 })) playTone(660, 0, 0.04, 'triangle', 0.03); }
    }
    function activateUiFocus() {
      const items = uiFocusables();
      if (!uiFocusEl || !items.includes(uiFocusEl)) {
        if (modalsOpen === 'island') { runPrimaryIslandAction(); return; }
        focusUiElement(items[0]);
        return;
      }
      if (uiFocusEl.matches('input')) { uiFocusEl.focus(); return; }
      if (!sfx('uiClick', { vol: 0.4 })) { playTone(880, 0, 0.05, 'triangle', 0.04); }
      uiFocusEl.click();
    }

    // ============================================================================
    // FÍSICA DO CARRINHO — PASSO FIXO DE 60 Hz (independente do refresh do monitor)
    // ============================================================================
    let carSpeed = 0;
    let carAngle = -0.55;
    const baseMaxSpeed = 0.36;
    const acceleration = 0.016;
    const friction = 0.93;
    const turnSpeed = 0.048;

    const PHYS_STEP = 1 / 60;
    const GRAVITY = 0.026;
    const JUMP_VELOCITY = 0.36;
    const CAR_DESK_Y = 0.14;
    const FLOOR_CAR_Y = -35.71;
    const RAMP_SLOPE = 35.85 / 45;
    const CAR_RADIUS = 1.45;
    const CAR_MASS = 1.6;
    let physAccumulator = 0;
    let carAirborne = false;
    let carAirPeakY = 0;
    let carAirStartedOnDesk = false;
    let carOnRamp = false;
    let lastGroundWasFootrest = false;
    let wasOnFootrest = false;
    let carPitch = 0, carRoll = 0;
    let pencilDrawTime = 0;
    let hasDescendedToRoom = false;
    let wasInLake = false;
    let wasInMud = false;
    let carHeavyPush = false;
    let bajaSideTilt = 0;
    let lastSafeAt = -10;
    const safeSpots = []; // turbo/nitro ligado: consegue empurrar objetos pesados (pilhas de pneus)
    let lastRallyBlockSpeech = -10, lastMudSpeech = -10, lastGroundRise = 0, lastDirtApplied = 0;

    // Mini-turbo das pilhas palito
    let turboBoostTimer = 0;
    const turboSparks = [];
    const sparkGeo = new THREE.SphereGeometry(0.16, 8, 8);
    const sparkMatCyan = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    const sparkMatGold = new THREE.MeshBasicMaterial({ color: 0xffea00 });

    function spawnTurboSpark() {
      const sp = new THREE.Mesh(sparkGeo, Math.random() > 0.5 ? sparkMatCyan : sparkMatGold);
      const backX = vehicle.position.x - Math.sin(carAngle) * 1.9 + (Math.random() - 0.5) * 0.8;
      const backZ = vehicle.position.z - Math.cos(carAngle) * 1.9 + (Math.random() - 0.5) * 0.8;
      sp.position.set(backX, vehicle.position.y + 0.55 + Math.random() * 0.4, backZ);
      scene.add(sp);
      turboSparks.push({
        mesh: sp,
        vel: new THREE.Vector3(
          -Math.sin(carAngle) * 0.25 + (Math.random() - 0.5) * 0.12,
          0.06 + Math.random() * 0.08,
          -Math.cos(carAngle) * 0.25 + (Math.random() - 0.5) * 0.12
        ),
        life: 22
      });
    }

    let lastTypeTime = 0;
    const codeSnippets = [
      'sudo rm -rf /system/core --no-preserve-root',
      'override_safety_locks(TRUE);',
      'INIT_SELF_DESTRUCT_SEQUENCE(0x99F);',
      'voltage_multiplier = 9999.9;',
      'CRITICAL_OVERHEAT_WARNING();',
      'disabling_cooling_fans()...'
    ];

    // Faixas das rampas de papelão (tampo de 16 de largura: z 10..26 e 30..46)
    function rampZoneAt(x, z) {
      if (x > -DESK_HALF_W + 2.0 || x < -138) return null;
      if (z >= 9.6 && z <= 26.4) return 'down';
      if (z >= 29.6 && z <= 46.4) return 'up';
      return null;
    }
    function rampHeightAt(x) {
      const progress = clamp((-DESK_HALF_W - x) / 45.0, 0, 1);
      return CAR_DESK_Y - progress * 35.85;
    }

    // Placa do apoio de pés e rampa contínua sob a mesa (centro x = 4; largura 16.2; extensão z de -24.0 a 4.5)
    const FOOTREST = { x0: -4.1, x1: 12.1, z0: -15.2, z1: -5.2, zStart: -24.0, zEnd: 4.5 };
    function footrestTopAt(z) {
      return 2.5 + 0.55 / Math.cos(0.38) + (z + 10) * Math.tan(0.38);
    }

    // Altura do chão sob o carrinho levando em conta o nível atual (mesa, rampa ou quarto)
    function sampleGround(x, z, curY) {
      const zone = rampZoneAt(x, z);
      if (zone) {
        const rh = rampHeightAt(x);
        if (curY > rh - 2.5) return { y: rh, ramp: zone, level: levelOfY(rh) };
      }
      if (curY > -15 && Math.abs(x) <= DESK_HALF_W + 1.2 && Math.abs(z) <= DESK_HALF_D + 1.2) {
        return { y: CAR_DESK_Y, ramp: null, level: 'desk' };
      }
      // Rampa contínua bidirecional de papelão sob a mesa (Apoio de pés / Atalho completo com subida, platô e descida)
      if (x >= FOOTREST.x0 - 0.8 && x <= FOOTREST.x1 + 0.8 && z >= FOOTREST.zStart - 0.6 && z <= FOOTREST.zEnd + 0.6) {
        let rampY = FLOOR_CAR_Y;
        if (z < FOOTREST.z0) {
          // 1. Rampa traseira (sobe suavemente do chão até o apoio de pés)
          const t = clamp((z - FOOTREST.zStart) / (FOOTREST.z0 - FOOTREST.zStart), 0, 1);
          const topA = FLOOR_SURFACE_Y + footrestTopAt(FOOTREST.z0) + 0.15;
          rampY = FLOOR_CAR_Y + t * (topA - FLOOR_CAR_Y);
        } else if (z <= FOOTREST.z1) {
          // 2. Placa central do apoio de pés (inclinada)
          rampY = FLOOR_SURFACE_Y + footrestTopAt(z) + 0.15;
        } else {
          // 3. Rampa frontal de saída (desce suavemente até o chão em frente à mesa)
          const t = clamp((FOOTREST.zEnd - z) / (FOOTREST.zEnd - FOOTREST.z1), 0, 1);
          const topB = FLOOR_SURFACE_Y + footrestTopAt(FOOTREST.z1) + 0.15;
          rampY = FLOOR_CAR_Y + t * (topB - FLOOR_CAR_Y);
        }
        if (curY > rampY - 2.4) {
          return { y: rampY, ramp: 'shortcut', level: 'floor', footrest: true };
        }
      }
      // Setor Baja Rally (ponte de madeira, riacho, poças de lama, troncos e pedrinhas)
      const rally = bajaRallyGround(x, z, curY);
      if (rally) {
        return Object.assign({ ramp: null, level: 'floor' }, rally);
      }
      // Ilhas (gramado elevado) e fundo do lago
      const extra = floorExtraHeight(x, z);
      return { y: FLOOR_CAR_Y + extra, ramp: null, level: 'floor', lake: extra < 0, island: extra > 0 };
    }

    function bajaRallyGround(x, z, curY) {
      if (!IS_QUINTAL || x < 128) return null;
      const hCar = curY - FLOOR_CAR_Y;
      // 1. Estrada (escolhe a passagem certa nos cruzamentos pela altura do carrinho)
      const q = rallyNearestY(x, z, hCar);
      if (q && Math.abs(q.lat) < RALLY_SIDE + 0.6) {
        if (q.y > 0.05) return { y: FLOOR_CAR_Y + q.y, rally: true, elevated: true, rallyT: q.t, slope: q.dy, yaw: q.yaw };
        const ob = rallyObstacleAt(x, z);
        if (ob && ob.h > 0.03) return { y: FLOOR_CAR_Y + ob.h, rally: true, rallyObs: ob.o.kind, rallyT: ob.o.t };
        const mud = Math.abs(q.lat) < RALLY_SIDE && RALLY_MUD.some(([a0, a1]) => q.t >= a0 && q.t <= a1);
        return { y: FLOOR_CAR_Y - (mud ? 0.06 : 0), rally: true, mud, rallyT: q.t };
      }
      // 2. Lago do miolo e piscina da cachoeira
      if (Math.hypot(x - POND.x, z - POND.z) < POND.r - 0.3 ||
        Math.hypot(x - WATERFALL.pool.x, (z - WATERFALL.pool.z) / 1.15) < WATERFALL.pool.r - 0.3) return { y: FLOOR_CAR_Y - 0.28, lake: true };
      // 3. Terreno da montanha (barranco alto demais vira parede)
      const mh = mountainH(x, z);
      if (mh > 0.03) {
        if (mh - hCar > 0.9) return { wall: true, wallName: 'Barranco da montanha', y: FLOOR_CAR_Y + mh };
        return { y: FLOOR_CAR_Y + mh, terrain: true };
      }
      return null;
    }

    // Quique em objetos fixos/paredes; 3 batidas seguidas = capotamento
    let lastFixedHitTarget = null;
    let fixedHitCount = 0;
    let lastFixedHitTime = 0;
    let isSomersaulting = false;
    let somersaultAngle = 0;

    function launchVehicle(vy) {
      carAirborne = true;
      fallVelocityY = vy;
      carAirPeakY = vehicle.position.y;
      carAirStartedOnDesk = vehicle.position.y > -15;
    }

    // Som de impacto proporcional à força (toque leve x pancada), sem repetir a cada passo
    function playImpactSound(obs, impact, mass = 1) {
      const now = performance.now();
      if (impact < 0.04 || (obs && now - (obs.lastSoundAt || 0) < 160)) return;
      if (obs) obs.lastSoundAt = now;
      const strength = clamp(impact / 0.4, 0, 1);
      const pitch = 260 / Math.sqrt(Math.max(0.3, mass));
      const nm = obs && obs.name ? obs.name : '';
      const group = !obs ? 'hitWall' : /CLIP|GRAMPEADOR|CESTO|LATA|METAL/i.test(nm) ? 'hitMetal' : /COPO|CRISTAL|VIDRO/i.test(nm) ? 'hitGlass'
        : mass < 0.3 ? 'hitLight' : mass < 1.3 ? 'hitWood' : mass >= 4 ? 'hitSoft' : 'hitHeavy';
      const played = sfx(group, { vol: 0.18 + strength * 0.55, rate: Math.min(1.5, Math.max(0.7, 1.15 / Math.sqrt(Math.max(0.4, mass)))) });
      if (!played) {
        playTone(pitch * (0.85 + Math.random() * 0.3), 0, 0.06 + strength * 0.12, strength > 0.5 ? 'square' : 'triangle', 0.02 + strength * 0.08);
        if (strength > 0.6) playTone(pitch * 0.5, 0.01, 0.18, 'sawtooth', 0.04);
      }
    }

    function handleFixedBounce(obstacleOrWallName, impact = 0.3) {
      const now = performance.now();
      // Ignora o mesmo contato contínuo (antes contava 1 batida por frame e capotava na hora)
      if (now - lastFixedHitTime < 350) return;
      if (now - lastFixedHitTime < 2500 && lastFixedHitTarget === obstacleOrWallName) fixedHitCount++;
      else { lastFixedHitTarget = obstacleOrWallName; fixedHitCount = 1; }
      lastFixedHitTime = now;

      if (fixedHitCount >= 3) {
        isSomersaulting = true;
        somersaultAngle = 0;
        launchVehicle(0.5);
        carSpeed = -0.3;
        fixedHitCount = 0;
        showCarSpeech('Eita! Capotei!', 2800);
        setStatusBanner('🤸 O carrinho capotou para trás após insistir na colisão!', '#ff5722');
        logInteractionEvent('🤸 O carrinho insistiu na colisão com ' + obstacleOrWallName + ' e capotou!');
        unlockAchievement('acrobat');
      } else {
        // Quique proporcional à força: batidas médias só recuam, fortes dão um pulinho
        if (!carAirborne && impact > 0.25) launchVehicle(Math.min(0.24, 0.08 + impact * 0.35));
        carSpeed = -Math.max(0.06, Math.abs(carSpeed) * (0.25 + impact * 0.6));
        rumble(0.4, 0.7, 140);
        showCarSpeech('Quicou!', 1300);
        setStatusBanner(`⚡ Bateu em ${obstacleOrWallName} (${fixedHitCount}/3)! Quicou para trás.`);
      }
    }

    function triggerCarJump() {
      // Baja no ar: F faz a cambalhota (para frente, ou de lado se estiver virando)
      if (currentVehicleType === 'baja' && carAirborne && !isFallingOff && !inputBlocked()) {
        const st = clamp((keys.left ? 1 : 0) - (keys.right ? 1 : 0) + (padInput.steer || 0), -1, 1);
        startBajaFlip(Math.abs(st) > 0.3 ? 'side' : 'front', Math.sign(st) || 1, false);
        return;
      }
      if (carAirborne || isSomersaulting || isFallingOff || inputBlocked()) return;
      launchVehicle(JUMP_VELOCITY);
      showCarSpeech('Pulo!', 1400);
      setStatusBanner('🦘 Pulo com [F]!', '#35e0ff');
      logInteractionEvent('🦘 Ravi deu um pulo com o carrinho!');
      progressAchievement('jumper', 1);
    }

    // ============================================================================
    // COLISOR DO CARRINHO: cápsula ao longo da carroceria (antes era um círculo de raio 1.45,
    // e o nariz/traseira de ~2.1 entravam nos objetos). Objetos quadrados usam caixa orientada.
    // ============================================================================
    const CAR_COL_R = 1.4;      // meia-largura incluindo os pneus grandes
    const CAR_COL_HALF = 0.82;  // meio-comprimento do "osso" da cápsula (total ≈ 4.4, com para-choques)

    function obstacleBoxRotation(obs) {
      return obs.group ? obs.group.rotation.y : (obs.boxRot || 0);
    }
    // Círculo (px,pz,r) x caixa orientada do obstáculo → { nx, nz, overlap } (normal aponta para o círculo)
    function circleVsBox(px, pz, r, obs) {
      const th = obstacleBoxRotation(obs), c = Math.cos(th), s = Math.sin(th);
      const dx = px - obs.x, dz = pz - obs.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const hx = obs.box.hx, hz = obs.box.hz;
      const qx = clamp(lx, -hx, hx), qz = clamp(lz, -hz, hz);
      const ex = lx - qx, ez = lz - qz;
      const d = Math.hypot(ex, ez);
      let nlx, nlz, overlap;
      if (d > 1e-6) {
        if (d >= r) return null;
        nlx = ex / d; nlz = ez / d; overlap = r - d;
      } else {
        // Centro dentro da caixa: sai pelo lado mais próximo
        const px2 = hx - Math.abs(lx), pz2 = hz - Math.abs(lz);
        if (px2 < pz2) { nlx = Math.sign(lx) || 1; nlz = 0; overlap = r + px2; }
        else { nlx = 0; nlz = Math.sign(lz) || 1; overlap = r + pz2; }
      }
      // Ponto de contato na superfície da caixa (mundo): usado para o giro (torque) nas batidas
      return { nx: nlx * c + nlz * s, nz: -nlx * s + nlz * c, overlap, px: obs.x + qx * c + qz * s, pz: obs.z - qx * s + qz * c };
    }
    // Faixa vertical ocupada por um objeto móvel (para não colidir com quem está em outra fileira/altura)
    function dynVerticalSpan(o) {
      const y0 = o.group ? o.group.position.y : 0;
      return [y0, y0 + (o.h || o.r * 2)];
    }
    // Eixos do OBB no mundo: [eixo x local, eixo z local]
    function boxAxesOf(o) {
      const th = obstacleBoxRotation(o), c = Math.cos(th), s = Math.sin(th);
      return [[c, -s], [s, c]];
    }
    // Contato entre dois objetos móveis (normal de a para b) + ponto de contato aproximado
    function dynPairContact(a, b) {
      if (a.box && b.box) {
        // Teorema do eixo separador (2D) entre duas caixas orientadas
        const A = boxAxesOf(a), B = boxAxesOf(b);
        const dx = b.x - a.x, dz = b.z - a.z;
        let best = Infinity, bnx = 0, bnz = 0;
        for (const u of [A[0], A[1], B[0], B[1]]) {
          const rA = a.box.hx * Math.abs(u[0] * A[0][0] + u[1] * A[0][1]) + a.box.hz * Math.abs(u[0] * A[1][0] + u[1] * A[1][1]);
          const rB = b.box.hx * Math.abs(u[0] * B[0][0] + u[1] * B[0][1]) + b.box.hz * Math.abs(u[0] * B[1][0] + u[1] * B[1][1]);
          const dist = dx * u[0] + dz * u[1];
          const ov = rA + rB - Math.abs(dist);
          if (ov <= 0) return null;
          if (ov < best) { best = ov; const sg = dist >= 0 ? 1 : -1; bnx = u[0] * sg; bnz = u[1] * sg; }
        }
        // Ponto de contato: média dos cantos de B mais enterrados em A
        const corners = [];
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          corners.push([b.x + B[0][0] * b.box.hx * sx + B[1][0] * b.box.hz * sz, b.z + B[0][1] * b.box.hx * sx + B[1][1] * b.box.hz * sz]);
        }
        const proj = corners.map(p => p[0] * bnx + p[1] * bnz);
        const minP = Math.min(...proj);
        const deep = corners.filter((p, i) => proj[i] < minP + 0.15);
        const px = deep.reduce((s, p) => s + p[0], 0) / deep.length, pz = deep.reduce((s, p) => s + p[1], 0) / deep.length;
        return { nx: bnx, nz: bnz, overlap: best, px, pz };
      }
      if (a.box || b.box) {
        const boxO = a.box ? a : b, circ = a.box ? b : a;
        const c = circleVsBox(circ.x, circ.z, circ.r, boxO);
        if (!c) return null;
        // circleVsBox aponta para o círculo; converte para "de a para b"
        const sg = a.box ? 1 : -1;
        return { nx: c.nx * sg, nz: c.nz * sg, overlap: c.overlap, px: c.px, pz: c.pz };
      }
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), minD = a.r + b.r;
      if (d >= minD || d < 1e-4) return null;
      return { nx: dx / d, nz: dz / d, overlap: minD - d, px: a.x + dx / d * a.r, pz: a.z + dz / d * a.r };
    }
    // Momento de inércia aproximado no eixo vertical (caixa ou disco)
    function dynInertia(o) {
      const m = o.mass || 1;
      return o.box ? m * (o.box.hx * o.box.hx + o.box.hz * o.box.hz) / 3 : m * o.r * o.r * 0.4;
    }
    // Aplica um impulso (jx,jz) no ponto (px,pz): muda velocidade e giro (torque = r × J)
    function applyDynImpulse(o, jx, jz, px, pz, spinK = 1) {
      const m = o.mass || 1;
      o.vx += jx / m; o.vz += jz / m;
      if (o.pin || o.ball || (o.stackOffset > 0) || px === undefined) return;
      const rx = px - o.x, rz = pz - o.z;
      const torque = rz * jx - rx * jz;
      o.vRotY = clamp((o.vRotY || 0) + spinK * torque / dynInertia(o), -0.3, 0.3);
    }
    // Contato da cápsula do carrinho (centro cx,cz, ângulo ang) com um obstáculo
    function carContact(obs, cx, cz, ang) {
      const fx = Math.sin(ang), fz = Math.cos(ang);
      if (obs.box) {
        let best = null;
        for (const t of [-CAR_COL_HALF, -CAR_COL_HALF / 2, 0, CAR_COL_HALF / 2, CAR_COL_HALF]) {
          const c = circleVsBox(cx + fx * t, cz + fz * t, CAR_COL_R, obs);
          if (c && (!best || c.overlap > best.overlap)) best = c;
        }
        return best;
      }
      const t = clamp((obs.x - cx) * fx + (obs.z - cz) * fz, -CAR_COL_HALF, CAR_COL_HALF);
      const px = cx + fx * t, pz = cz + fz * t;
      const dx = px - obs.x, dz = pz - obs.z;
      const d = Math.hypot(dx, dz);
      const minD = obs.r + CAR_COL_R;
      if (d >= minD) return null;
      if (d < 1e-6) return { nx: -fx, nz: -fz, overlap: minD, px: obs.x, pz: obs.z };
      return { nx: dx / d, nz: dz / d, overlap: minD - d, px: obs.x + dx / d * obs.r, pz: obs.z + dz / d * obs.r };
    }
    // Um objeto móvel está "preso" se a nova posição invade a parede ou um obstáculo fixo:
    // nesse caso quem recua é o carrinho (senão o objeto seria empurrado para dentro do carro)
    function dynamicObjectBlockedAt(obs, ox, oz) {
      // Mesma métrica usada pela física objeto x fixo (círculos de raio r) e pelas paredes
      const wallExt = obs.box ? Math.max(obs.box.hx, obs.box.hz) : obs.r;
      if (obs.level === 'floor' && (ox < BOUNDS.minX - 2 + wallExt || ox > BOUNDS.maxX + 1 - wallExt || oz < BOUNDS.minZ - 2 + wallExt || oz > BOUNDS.maxZ + 2 - wallExt)) return true;
      ensureStaticGrid();
      return forEachNear(staticGrid, obs.level, ox, oz, obs.r, (s) => {
        if (s._dyn || s === obs || (s.level || 'desk') !== obs.level || s.r < 0.01 || s.y0 !== undefined) return false;
        return Math.hypot(ox - s.x, oz - s.z) < obs.r + s.r - 0.01;
      });
    }

    function dynamicOverlapsOtherDynamic(obs, ox, oz) {
      return forEachNear(dynGrid, obs.level, ox, oz, obs.r + 2, (o) => {
        if (o === obs || o.isFalling || o.level !== obs.level || o.r < 0.01) return false;
        return Math.hypot(ox - o.x, oz - o.z) < obs.r + o.r - 0.05;
      });
    }

    function obstacleCollidesWithCar(obs, carLevel, carHeight) {
      if (heldItem && heldItem.obs === obs) return false;
      if (obs.isFalling || obs.r < 0.01) return false;
      if ((obs.level || 'desk') !== carLevel) return false;
      if (obs.h !== undefined && carHeight > obs.h - 0.15) return false; // pulou por cima
      if (obs.y0 !== undefined && carHeight + 2.6 < obs.y0) return false; // passou por baixo (guarda-corpo da ponte)
      return true;
    }

    function stepVehicle(time) {
      const dt = PHYS_STEP;

      if (isFallingOff) {
        // Saiu dos limites do quarto: queda livre até abrir o modal de reinício
        fallVelocityY -= 0.035;
        vehicle.position.y += fallVelocityY;
        vehicle.position.x += Math.sin(carAngle) * carSpeed;
        vehicle.position.z += Math.cos(carAngle) * carSpeed;
        vehicle.rotation.x += 0.06;
        vehicle.rotation.z += 0.04;
        if (vehicle.position.y < -55 && !isModalOpen) {
          openModal('O carrinho saiu do quarto!', 'Você ultrapassou as paredes do quarto. Deseja reiniciar o jogo e restaurar tudo?', true);
        }
        return;
      }

      // Entradas combinadas: teclado/touch (digital) + gamepad (analógico)
      const blocked = inputBlocked();
      const ts = touchStickAxes();
      const throttle = blocked ? 0 : Math.max(keys.forward ? 1 : 0, padInput.throttle, ts.throttle);
      const reverse = blocked ? 0 : Math.max(keys.backward ? 1 : 0, padInput.reverse, ts.reverse);
      const steer = blocked ? 0 : clamp((keys.left ? 1 : 0) - (keys.right ? 1 : 0) + padInput.steer + ts.steer, -1, 1);
      const boosting = !blocked && (keys.boost || padInput.boost);
      const braking = !blocked && padInput.brake;
      const kF = throttle > 0.05, kB = reverse > 0.05;
      const kL = steer > 0.05, kR = steer < -0.05;

      if (kF || kB) {
        accelContinuousTime += dt;
        if (accelContinuousTime >= 5.0 && time - lastVrumSpeechTime > 6.5) {
          lastVrumSpeechTime = time;
          showCarSpeech('vrum vrumm', 2800);
          logInteractionEvent('🏎️ Ravi acelerando por +5s: "vrum vrumm"');
        }
      } else {
        accelContinuousTime = 0;
      }

      if (turboBoostTimer > 0) {
        turboBoostTimer -= dt;
        spawnTurboSpark();
      }
      // Bateria: abaixo de 10% o carrinho perde a força (anda bem devagar até recarregar)
      const lowPower = carBattery < 10;
      const boostOn = boosting && !lowPower;
      // Acima de 120%: sobrecarga = modo NITRO (mais rápido, chamas azuis no escapamento)
      const nitroOn = carBattery >= BATTERY_NITRO_AT;
      const powerK = lowPower ? 0.3 : nitroOn ? 1.5 : 1;
      if (nitroOn !== nitroActive) setNitro(nitroOn);
      if (carBattery > 100) {
        // Sobrecarga se dissipa sozinha devagar (e mais rápido acelerando no nitro)
        const prevPct = Math.round(carBattery);
        // Dourada segura 120% um tempinho: o nitro só começa a cair quando o carrinho acelera
        carBattery = Math.max(100, carBattery - dt * (0.3 + (kF ? 1.6 * throttle : 0)));
        if (Math.round(carBattery) !== prevPct) updateBatteryHUD();
      } else if ((kF || kB) && !carAirborne) {
        const prevPct = Math.round(carBattery);
        carBattery = Math.max(0, carBattery - dt * 0.75 * Math.max(throttle, reverse) * (boostOn ? 2.2 : 1));
        if (Math.round(carBattery) !== prevPct) updateBatteryHUD();
        if (carBattery < 10 && !batteryLowWarned) {
          batteryLowWarned = true;
          showCarSpeech('ihhh acabou a pilha, preciso achar alguma pilha perdida, ou ir até o postinho', 3500);
          setStatusBanner('🔋 Bateria baixa! Procure uma pilha perdida ou vá até o Posto do Bombeiro.', '#ff5252');
          notify({ type: 'danger', title: 'Bateria fraca', description: 'ihhh acabou a pilha, preciso achar alguma pilha perdida, ou ir até o postinho', duration: 4000 });
        }
      }
      // Baja: arranque mais forte e um pouco mais de velocidade final (carro de competição)
      const vehicleK = currentVehicleType === 'baja' ? 1.08 : 1;
      const accelK = currentVehicleType === 'baja' ? 1.25 : 1;
      carHeavyPush = boostOn || turboBoostTimer > 0 || nitroOn;
      const currentMaxSpeed = (turboBoostTimer > 0 ? baseMaxSpeed * 1.9 : baseMaxSpeed) * (boostOn ? 1.35 : 1) * (nitroOn ? 1.45 : powerK) * vehicleK;
      if (boostOn && kF && Math.random() < 0.35) spawnTurboSpark();
      if (nitroOn) updateNitroFlames(kF ? throttle : 0.25);

      if (!carAirborne) {
        if (braking) carSpeed *= 0.86;
        else if (kF) carSpeed = Math.min(carSpeed + acceleration * accelK * powerK * throttle * (turboBoostTimer > 0 ? 2.4 : 1) * (boostOn ? 1.4 : 1), currentMaxSpeed);
        else if (kB) carSpeed = Math.max(carSpeed - acceleration * powerK * reverse, -currentMaxSpeed * 0.65);
        else if (turboBoostTimer > 0) carSpeed = Math.max(carSpeed, baseMaxSpeed * 1.65);
        else carSpeed *= friction;
        if (carSpeed > currentMaxSpeed) carSpeed += (currentMaxSpeed - carSpeed) * 0.08; // fim do boost: desacelera suave
      } else {
        carSpeed *= 0.997; // arrasto do ar: sem tração no ar
      }

      // Direção: em velocidade alta o raio de curva crescia demais ("não vira").
      // Agora o esterço ganha força com a velocidade e, ao esterçar forte em alta, o carrinho alivia um pouco
      // sozinho (ajuda a fazer a curva sem soltar o acelerador). Parado, esterçar + acelerar já sai girando.
      const spAbs = Math.abs(carSpeed);
      if (spAbs > 0.004 || (Math.abs(steer) > 0.05 && (kF || kB) && !carAirborne)) {
        const dir = carSpeed < -0.004 || (spAbs <= 0.004 && kB && !kF) ? -1 : 1;
        const spK = Math.min(spAbs / baseMaxSpeed, 1.8);
        const grip = 0.75 + 0.25 * Math.min(1, spK * 3); // bem devagar gira um pouco menos (sem pião no lugar)
        const rate = (carAirborne ? turnSpeed * 0.35 : turnSpeed * grip * (1 + 0.32 * spK)) * steerSens;
        carAngle += rate * dir * steer;
        if (!carAirborne && Math.abs(steer) > 0.45 && spK > 0.7) carSpeed *= 1 - 0.006 * Math.abs(steer);
      }

      const curX = vehicle.position.x, curZ = vehicle.position.z, curY = vehicle.position.y;
      let nextX = curX + Math.sin(carAngle) * carSpeed;
      let nextZ = curZ + Math.cos(carAngle) * carSpeed;
      const velX = Math.sin(carAngle) * carSpeed, velZ = Math.cos(carAngle) * carSpeed;

      // Abas laterais de papelão seguram o carrinho dentro da rampa
      if (carOnRamp && curX < -DESK_HALF_W - 0.5 && curX > -133.5) {
        const zone = rampZoneAt(curX, curZ);
        if (zone) {
          const zMin = zone === 'down' ? 10.8 : 30.8, zMax = zone === 'down' ? 25.2 : 45.2;
          if (nextZ < zMin || nextZ > zMax) { nextZ = clamp(nextZ, zMin, zMax); carSpeed *= 0.94; }
        }
      }

      // Paredes do quarto
      if (curY < -15) {
        const wallHit = (name, nx, nz) => {
          const approach = -(velX * nx + velZ * nz);
          if (approach > 0.08) { handleFixedBounce(name, approach); playImpactSound(null, approach, 8); }
          else carSpeed *= 0.9;
        };
        const wallN = IS_QUINTAL ? 'Cerca' : 'Parede';
        if (nextX <= BOUNDS.minX) { nextX = BOUNDS.minX + 0.5; wallHit(IS_QUINTAL ? 'Parede da casa' : 'Parede esquerda', 1, 0); }
        else if (nextX >= BOUNDS.maxX) { nextX = BOUNDS.maxX - 0.5; wallHit(wallN + ' (leste)', -1, 0); }
        if (nextZ <= BOUNDS.minZ) { nextZ = BOUNDS.minZ + 0.5; wallHit(wallN + ' do fundo', 0, 1); }
        else if (nextZ >= BOUNDS.maxZ) { nextZ = BOUNDS.maxZ - 0.5; wallHit(wallN + ' da frente', 0, -1); }
      }
      if (nextX < BOUNDS.minX - 10 || nextX > BOUNDS.maxX + 10 || nextZ < BOUNDS.minZ - 10 || nextZ > BOUNDS.maxZ + 10) {
        isFallingOff = true;
        fallVelocityY = -0.15;
        return;
      }

      // Colisões com obstáculos (somente do mesmo nível e na altura do carrinho)
      const carLevel = levelOfY(curY);
      // Na rampa a altura do carrinho é medida a partir da própria rampa (antes, na metade de baixo, ele não colidia com nada)
      const carHeight = carOnRamp ? curY - rampHeightAt(curX) : curY - (surfaceBaseY(curY) + CAR_DESK_Y);

      // Varredura em subpassos: em alta velocidade o carrinho para no primeiro contato
      // (impede "pular" objetos finos como tijolos e cercas entre um passo e outro)
      const moveLen = Math.hypot(nextX - curX, nextZ - curZ);
      if (moveLen > 0.3) {
        const sub = Math.ceil(moveLen / 0.3);
        for (let s = 1; s < sub; s++) {
          const tx = curX + (nextX - curX) * (s / sub), tz = curZ + (nextZ - curZ) * (s / sub);
          if (obstacles.some(o => obstacleCollidesWithCar(o, carLevel, carHeight) && carContact(o, tx, tz, carAngle))) {
            nextX = tx; nextZ = tz;
            break;
          }
        }
      }

      for (let i = 0; i < obstacles.length; i++) {
        const obs = obstacles[i];
        if (!obstacleCollidesWithCar(obs, carLevel, carHeight)) continue;
        const contact = carContact(obs, nextX, nextZ, carAngle);
        if (!contact) continue;

        const nx = contact.nx, nz = contact.nz;
        const overlap = contact.overlap;
        const approach = -(velX * nx + velZ * nz); // > 0 quando avança contra o objeto

        if (obs._dyn) {
          // Objeto empurrável: separação proporcional às massas + impulso pela velocidade RELATIVA
          // (um objeto que vem rolando também empurra o carrinho, e não atravessa mais)
          // Pesados (pilha de pneus): sem turbo quase não saem do lugar; com turbo/nitro são empurrados
          const pushK = obs.heavy && !carHeavyPush ? 0.06 : 1;
          const mass = (obs.mass || 1) / pushK;
          const inv = 1 / (CAR_MASS + mass);
          nextX += nx * overlap * mass * inv;
          nextZ += nz * overlap * mass * inv;
          obs.x -= nx * overlap * CAR_MASS * inv;
          obs.z -= nz * overlap * CAR_MASS * inv;
          const relApproach = -((velX - obs.vx) * nx + (velZ - obs.vz) * nz);
          if (relApproach > 0) {
            const strong = relApproach > 0.2;
            const restitution = obs.ball ? (obs.restitution || 0.5) : strong ? 0.45 : 0.25;
            const j = relApproach * (1 + restitution) / (1 / CAR_MASS + 1 / mass);
            const jo = j * pushK; // impulso que o objeto realmente recebe
            // Impulso normal aplicado no ponto de contato real: batida de quina gira o objeto (torque)
            applyDynImpulse(obs, -nx * jo, -nz * jo, contact.px, contact.pz, 0.8);
            if (obs.heavy && !carHeavyPush && relApproach > 0.12 && time - lastRallyBlockSpeech > 3) {
              lastRallyBlockSpeech = time;
              showCarSpeech('Pesado demais! Use o turbo 🚀', 1800);
            }
            if (obs.pin || obs.ball || !(contact.px !== undefined)) obs.vRotY += (Math.random() - 0.5) * 0.1 * (j / mass);
            // Atrito no contato: o objeto também ganha parte do movimento lateral do carrinho (não "escorrega" do para-choque)
            if (!obs.ball) {
              const tx = -nz, tz = nx;
              const vt = (velX - obs.vx) * tx + (velZ - obs.vz) * tz;
              const mEff = 1 / (1 / CAR_MASS + 1 / mass);
              const jt = clamp(vt * mEff * 0.5, -0.45 * j, 0.45 * j) * pushK;
              applyDynImpulse(obs, tx * jt, tz * jt, contact.px, contact.pz, 0.8);
            }
            // O carrinho recebe a reação ao longo da direção em que anda
            carSpeed += (nx * Math.sin(carAngle) + nz * Math.cos(carAngle)) * (j / CAR_MASS);
            if (obs.ball) {
              // Bola: sai na direção da normal do contato (batida de raspão desvia para o lado),
              // com a velocidade da colisão real (massa + restituição). Bola leve quica um pouco
              // porque o para-choque bate abaixo do centro dela; bola pesada só rola.
              obs.hopV = Math.max(obs.hopV || 0, Math.min(0.3, relApproach * (obs.lift || 0)));
              obs.vRotY = 0;
            } else if (strong && !obs.pin && !(obs.stackOffset > 0)) {
              // Batida forte: o objeto dá um pulinho e gira
              obs.hopV = Math.max(obs.hopV || 0, Math.min(0.32, (relApproach - 0.15) * 1.2) * (1.2 / Math.max(0.6, mass)));
            }
            if (obs.pin && relApproach > 0.03) knockPin(obs, -nx, -nz);
            if (obs.crate && relApproach > 0.12) explodeCrate(obs);
            if (obs.burstBox && relApproach > 0.22) burstBox(obs, -nx, -nz, relApproach * 2.5);
            if (obs.canTopple) {
              const tip = (strong ? 1.4 : 0.7) * (j / mass);
              obs.tiltX = clamp(obs.tiltX - nz * tip, -0.75, 0.75);
              obs.tiltZ = clamp(obs.tiltZ + nx * tip, -0.75, 0.75);
            }
            playImpactSound(obs, relApproach, mass);
            if (strong) rumble(0.25, 0.5, 90);
          }
          if (obs.group) { obs.group.position.x = obs.x; obs.group.position.z = obs.z; }
        } else {
          // Objeto fixo: raspão desliza pelo contorno; batida de frente forte quica para trás
          nextX += nx * (overlap + 0.02);
          nextZ += nz * (overlap + 0.02);
          const speedAbs = Math.abs(carSpeed);
          const headOn = speedAbs > 1e-4 ? clamp(approach / speedAbs, 0, 1) : 0;
          if (approach > 0.16 && headOn > 0.55) {
            handleFixedBounce(obs.name, approach);
            playImpactSound(obs, approach, 6);
          } else if (approach > 0) {
            carSpeed *= 1 - 0.6 * headOn;
            if (carSpeed > 0.02 && headOn < 0.8) {
              // Vira suavemente para a tangente do obstáculo (contorna em vez de travar)
              const tx = -nz, tz = nx;
              const side = Math.sin(carAngle) * tx + Math.cos(carAngle) * tz >= 0 ? 1 : -1;
              let dA = Math.atan2(tx * side, tz * side) - carAngle;
              dA = Math.atan2(Math.sin(dA), Math.cos(dA));
              carAngle += dA * 0.15;
            }
            if (approach > 0.05) playImpactSound(obs, approach, 6);
          }
        }

        if (obs.type === 'water_cup' && !cupSpilled) {
          // Cai para o lado oposto ao carrinho (direção da batida)
          spillCup(-nx, -nz);
          showCarSpeech(breakSpeechToggle ? 'eita' : 'ops', 2200);
          breakSpeechToggle = !breakSpeechToggle;
          setStatusBanner('🌊 Você derrubou o copo! Pare sobre a poça azul para encher o tanque!', '#35e0ff');
          logInteractionEvent('🌊 Copo derrubado! Água espalhada na mesa para recarga.');
          unlockAchievement('oops');
        }
        if (obs.breakable) hitBreakable(obs, approach);
        if (obs.type === 'controller' && approach > 0.04) {
          hitController(obs.ctrlRef, approach);
          logInteractionEvent(`💥 Batida no ${obs.ctrlRef.name}: ${obs.ctrlRef.hits} impactos (parte ${obs.ctrlRef.stage}/4)`);
        }
      }

      // Passadas extras só de posição: ao sair de um objeto o carrinho não pode entrar em outro
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        for (let i = 0; i < obstacles.length; i++) {
          const obs = obstacles[i];
          if (!obstacleCollidesWithCar(obs, carLevel, carHeight)) continue;
          const contact = carContact(obs, nextX, nextZ, carAngle);
          if (!contact || contact.overlap < 0.005) continue;
          // Objeto móvel cede para fora do carrinho — a menos que esteja preso contra a parede
          const ox = obs.x - contact.nx * contact.overlap, oz = obs.z - contact.nz * contact.overlap;
          const pinned = obs._dyn && ((obs.heavy && !carHeavyPush) || dynamicObjectBlockedAt(obs, ox, oz));
          if (obs._dyn && !pinned) {
            obs.x = ox; obs.z = oz;
            if (obs.group) { obs.group.position.x = obs.x; obs.group.position.z = obs.z; }
          } else {
            nextX += contact.nx * (contact.overlap + 0.01);
            nextZ += contact.nz * (contact.overlap + 0.01);
          }
          moved = true;
        }
        if (!moved) break;
      }

      // Superfície sob o carrinho
      let g = sampleGround(nextX, nextZ, curY);
      if (g.wall) {
        // Bateu na lateral/frente alta do apoio de pés: volta e quica
        nextX = curX; nextZ = curZ;
        if (Math.abs(carSpeed) > 0.12) handleFixedBounce(g.wallName || 'Apoio de pés', Math.abs(carSpeed));
        else carSpeed *= -0.3;
        g = sampleGround(nextX, nextZ, curY);
      }
      // Obstáculos do rally: o Baja sobe; o caminhãozinho para na base (não tem suspensão nem tração)
      const isBajaCar = currentVehicleType === 'baja';
      if (!isBajaCar && g.rallyObs && !carAirborne) {
        const hNext = g.y - FLOOR_CAR_Y, hCur = curY - FLOOR_CAR_Y;
        if (hNext > 0.3 && hNext > hCur + 1e-4) {
          nextX = curX; nextZ = curZ;
          carSpeed = -carSpeed * 0.25;
          if (time - lastRallyBlockSpeech > 3) {
            lastRallyBlockSpeech = time;
            showCarSpeech('Não consigo subir! Isso é coisa do Baja 😅', 2200);
            setStatusBanner('🚧 O caminhãozinho não sobe os obstáculos do rally. Pegue o Baja 13 na ilha do Baja!', '#ff7a1a');
          }
          g = sampleGround(nextX, nextZ, curY);
        }
      }
      let groundY = g.y;

      // Pilhas palito (na mesa e no circuito do chão): lombada + mini turbo
      if (!g.ramp) {
        const onMagic = isCarOnRainbowTrack(nextX, nextZ, groundY);
        turboBatteries.forEach((tb) => {
          if (tb.collected || tb.respawnAt) return; // agora somem de vez após coletadas!
          // Se a pista mágica está ativa e o carrinho está nela, ignora pilhas que estiverem sobre ela (para não explodir!)
          if (onMagic) {
            const isNearTrack = trackSamples.some(s => Math.abs(s.y - tb.y) < 4 && (s.x - tb.x) ** 2 + (s.z - tb.z) ** 2 < (TRACK_WIDTH / 2 + 1.2) ** 2);
            if (isNearTrack) return;
          }
          if (tb.level !== g.level || Math.hypot(nextX - tb.x, nextZ - tb.z) >= 2.65) return;
          groundY = Math.max(groundY, tb.y - 0.15 + 0.52);
          if (carHeight < 1.5 && time - tb.lastBoostTime > 1.2) {
            tb.lastBoostTime = time;
            collectBattery(tb, time);
          }
        });
      }

      // Lago & Riacho do Rally: água desacelera, respinga e enche o tanque
      if (g.lake && !carAirborne) {
        carSpeed *= 0.975;
        if (isBajaCar) bajaDirt = Math.max(0, bajaDirt - dt * 0.35); // a água lava a lama do Baja
        if (totalWater() < waterCapacity()) {
          addWater(dt * 30);
          updateWaterHUD();
          setStatusBanner(`💧 Enchendo o tanque: ${Math.round(totalWater())}%${holdingPistol() ? ' (com a pistola d\'água)' : ''}`, '#35e0ff');
        }
        if (Math.abs(carSpeed) > 0.05 && Math.random() < 0.5) splashAt(nextX - Math.sin(carAngle) * 1.2, FLOOR_SURFACE_Y + 0.3, nextZ - Math.cos(carAngle) * 1.2, 2, 0.6);
        if (!wasInLake) { showCarSpeech('Splash!', 1600); splashAt(nextX, FLOOR_SURFACE_Y + 0.3, nextZ, 16, 1.1); }
      }
      wasInLake = !!g.lake && !carAirborne;

      // Lamaçal do Rally: o Baja passa voando jogando lama para trás; o caminhãozinho atola e patina
      if (g.mud && !carAirborne) {
        const back = (k) => [nextX - Math.sin(carAngle) * 1.6 + Math.cos(carAngle) * k, nextZ - Math.cos(carAngle) * 1.6 - Math.sin(carAngle) * k];
        if (isBajaCar) {
          carSpeed *= 0.999;
          bajaDirt = Math.min(1, bajaDirt + dt * 0.12 * Math.min(1, Math.abs(carSpeed) * 4));
          if (Math.abs(carSpeed) > 0.04 && Math.random() < 0.55) sprayMud(nextX, nextZ, carAngle, carSpeed, Math.min(1.3, 0.35 + Math.abs(carSpeed) * 2.4));
        } else {
          carSpeed += (clamp(carSpeed, -0.05, 0.07) - carSpeed) * 0.35; // atolado: patina e anda devagar
          if ((kF || kB) && Math.random() < 0.7) sprayMud(nextX, nextZ, carAngle, 0.12, 0.35); // patinando: lama sobe das rodas
          if (!wasInMud || ((kF || kB) && time - lastMudSpeech > 5)) {
            lastMudSpeech = time;
            showCarSpeech('Atolei! 😩 Só o Baja anda rápido na lama', 2400);
          }
        }
        if (!wasInMud && !sfx('mud', { vol: 0.6, rate: 0.7 })) playTone(110, 0, 0.12, 'square', 0.04);
      }
      wasInMud = !!g.mud && !carAirborne;
      // Poeira da terra batida saindo das rodas traseiras
      if (g.rally && !g.mud && !carAirborne && Math.abs(carSpeed) > 0.14 && Math.random() < (isBajaCar ? 0.75 : 0.4)) {
        const side = Math.random() > 0.5 ? 1.1 : -1.1, sp = Math.abs(carSpeed) * 60;
        const bx = nextX - Math.sin(carAngle) * 1.5 + Math.cos(carAngle) * side, bz = nextZ - Math.cos(carAngle) * 1.5 - Math.sin(carAngle) * side;
        spawnDust(bx, groundY - FLOOR_CAR_Y + FLOOR_SURFACE_Y + 0.5, bz, -Math.sin(carAngle) * sp * 0.12 + (Math.random() - 0.5), -Math.cos(carAngle) * sp * 0.12 + (Math.random() - 0.5), isBajaCar ? 1.1 : 0.8);
      }

      // Chegada em uma ilha (descoberta de área, como no mundo do DS)
      if (g.island) {
        const isl = islandAt(nextX, nextZ);
        // Posto do Bombeiro (a "ilha do Ravi") recarrega a bateria enquanto o carrinho está nela
        if (isl && isl.id === 'fire' && carBattery < 100) {
          chargeBattery(dt * 25);
          setStatusBanner(`🔋 Carregando no Posto do Bombeiro: ${Math.round(carBattery)}%`, '#7ee787');
        }
      }
      // Base de recarga do Baja (ilha do Baja)
      if (bajaCharger) {
        const onPad = Math.hypot(nextX - BAJA_CHARGER.x, nextZ - BAJA_CHARGER.z) < BAJA_CHARGER.r && !carAirborne && curY < -15;
        if (onPad && !bajaCharger.charging) {
          showCarSpeech(currentVehicleType === 'baja' ? 'Recarregando o Baja! ⚡' : 'Recarregando! ⚡', 1800);
          playTone(660, 0, 0.08, 'triangle', 0.05); playTone(990, 0.08, 0.12, 'triangle', 0.05);
        }
        bajaCharger.charging = onPad && carBattery < 100;
        if (bajaCharger.charging) {
          chargeBattery(dt * 30);
          setStatusBanner(`⚡ Recarga do Baja: ${Math.round(carBattery)}%`, '#d5ff95');
        }
      }
      // Hidrante do Posto do Bombeiro: encostou, encheu
      if (hydrantObj && curY < -15 && Math.hypot(nextX - HYDRANT.x, nextZ - HYDRANT.z) < HYDRANT.r && totalWater() < waterCapacity()) {
          addWater(dt * 45);
          updateWaterHUD();
          setStatusBanner(`🚒 Enchendo no hidrante: ${Math.round(totalWater())}%`, '#35e0ff');
          if (Math.random() < 0.3) splashAt(HYDRANT.x + (Math.random() - 0.5), FLOOR_SURFACE_Y + 4, HYDRANT.z + (Math.random() - 0.5), 1, 0.5);
      }
      if (g.island) {
        const isl = islandAt(nextX, nextZ);
        if (isl && !isl.visited) {
          isl.visited = true;
          notify({ type: 'info', title: isl.name, description: 'Ilha descoberta! Procure o diamante para interagir.', duration: 3600 });
          trackAchievementSet('islands', isl.id);
        }
      }

      if (g.level === 'desk' && !g.ramp) {

        // Teclado mecânico: digita na tela e acumula autodestruição
        if (nextX > -3.2 && nextX < 12.2 && nextZ > 0.8 && nextZ < 7.2) {
          groundY = 0.78 + Math.sin(nextX * 5 + nextZ * 5) * 0.06;
          if (!carAirborne && Math.abs(carSpeed) > 0.02 && monitorState === 'normal') {
            monitorProfileMode = null; // digitar no teclado volta a tela para o terminal
            selfDestructProgress = Math.min(100, selfDestructProgress + dt * 24);
            if (time - lastTypeTime > 0.25) {
              lastTypeTime = time;
              typedTextLines.push('> ' + codeSnippets[Math.floor(Math.random() * codeSnippets.length)]);
              updateMonitorScreen();
            }
            if (selfDestructProgress >= 100) {
              monitorState = 'burning';
              fireTimer = 15.0;
              monitorFireGroup.visible = true;
              updateMonitorScreen();
              setStatusBanner('🔥 CÓDIGO DE AUTODESTRUIÇÃO ATIVADO! APAGUE O FOGO DO MONITOR!', '#ff5252');
              logInteractionEvent('🔥 Código de autodestruição 100%! Monitor 1 em chamas!');
            }
          }
        }

        // Poça d'água: recarrega o tanque
        if (cupSpilled && Math.hypot(nextX - puddleMesh.position.x, nextZ - puddleMesh.position.z) < 7.5 * puddleScale && totalWater() < waterCapacity()) {
          addWater(dt * 38);
          updateWaterHUD();
          setStatusBanner(`⚡ Abastecendo na poça d'água: ${Math.round(totalWater())}%`, '#35e0ff');
        }
      }

      // Integração vertical (pulos, quedas, quiques e aterrissagem)
      let y = curY;
      if (carAirborne) {
        fallVelocityY -= GRAVITY;
        y += fallVelocityY;
        carAirPeakY = Math.max(carAirPeakY, y);
        if (y <= groundY && fallVelocityY <= 0) {
          const impact = -fallVelocityY;
          const dropHeight = carAirPeakY - groundY;
          y = groundY;
          if (impact > (isBajaCar ? 0.55 : 0.35) && !isSomersaulting) {
            fallVelocityY = impact * (isBajaCar ? 0.12 : 0.28); // quique na aterrissagem (o Baja absorve na suspensão)
            carAirPeakY = y;
          } else {
            carAirborne = false;
            fallVelocityY = 0;
          }
          if (g.rally && impact > 0.18) {
            for (let k = 0; k < 10; k++) { const a = Math.random() * Math.PI * 2; spawnDust(nextX + Math.cos(a) * 1.5, groundY - FLOOR_CAR_Y + FLOOR_SURFACE_Y + 0.5, nextZ + Math.sin(a) * 1.5, Math.cos(a) * 4, Math.sin(a) * 4, 1.3); }
          }
          if (isBajaCar && impact > 0.78 && Math.abs(carSpeed) > 0.33 && !bajaFlip.active) startBajaFlip('front', 1, true);
          if (dropHeight > 12) {
            carSpeed *= 0.6;
            showCarSpeech('Cataploft! Caí no chão!', 3000);
            setStatusBanner('🛬 Você caiu e aterrissou são e salvo! Continue acelerando!', '#35e0ff');
            logInteractionEvent('🛬 O carrinho caiu e aterrissou no chão do quarto!');
            if (carAirStartedOnDesk && g.level === 'floor') unlockAchievement('skydiver');
            carAirStartedOnDesk = false;
          }
        }
      } else if (groundY < y - 1.0) {
        // Beirada: começa a cair (antes o carro "teleportava" ou flutuava)
        // Saindo do topo da rampa do apoio de pés: salto proporcional à velocidade (atalho!)
        launchVehicle(lastGroundWasFootrest ? Math.min(0.42, Math.abs(carSpeed) * 0.55 + 0.06) : clamp(lastGroundRise * 1.15, 0, 0.45));
        if (lastGroundWasFootrest && Math.abs(carSpeed) > 0.2) {
          showCarSpeech('Atalho secreto!', 1600);
          if (!achievementState.unlocked.shortcut) progressAchievement('shortcut', 1);
        }
        carAirPeakY = y;
      } else if (g.ramp || g.rallyObs || g.elevated || g.terrain) {
        y = groundY;
      } else {
        y += (groundY - y) * 0.35;
      }
      lastGroundWasFootrest = !!g.footrest && !carAirborne;
      carOnRamp = (!!g.ramp || !!g.footrest) && !carAirborne;

      lastGroundRise = carAirborne ? 0 : y - curY;
      // Rastro de pneu na terra/lama do rally (uma marca a cada ~0,9 de distância)
      if (g.rally && !carAirborne && !g.elevated && Math.abs(carSpeed) > 0.04) {
        trackMarkDist += Math.abs(carSpeed);
        if (trackMarkDist > 0.9) { trackMarkDist = 0; addTireTracks(nextX, y - FLOOR_CAR_Y + FLOOR_SURFACE_Y + 0.13, nextZ, carAngle, !!g.mud); }
      }
      // Última posição segura (para o botão Destravar): no chão, fora d'água, parado ou andando normalmente
      if (!carAirborne && !isSomersaulting && !g.lake && !g.wall && time - lastSafeAt > 0.5) {
        lastSafeAt = time;
        safeSpots.push({ x: nextX, z: nextZ, angle: carAngle, floor: y < -15 });
        if (safeSpots.length > 8) safeSpots.shift();
      }
      vehicle.position.set(nextX, y, nextZ);
      if (g.rally && g.rallyT !== undefined) updateRallyLap(g.rallyT, time);

      // Avisos de rampa
      if (carOnRamp && g.ramp === 'down' && nextX < -DESK_HALF_W - 3 && !hasDescendedToRoom) {
        hasDescendedToRoom = true;
        showCarSpeech('Uuuuh descendo pro quarto!', 3200);
        logInteractionEvent('🛝 Ravi descendo pela rampa de papelão para o quarto!');
      }
      if (carOnRamp && nextX < -128) unlockAchievement('slide');
      if (hasDescendedToRoom && g.level === 'desk' && !g.ramp) {
        hasDescendedToRoom = false;
        showCarSpeech('Voltando pra mesa!', 2600);
        logInteractionEvent('🏎️ Ravi voltou para a mesa!');
      }
      if (g.footrest && !wasOnFootrest && Math.abs(carSpeed) > 0.05) {
        showCarSpeech('⚡ Atalho da mesa!', 2000);
        logInteractionEvent('⚡ Ravi pegou o atalho sob a mesa!');
        playTone(523, 0, 0.08, 'triangle', 0.04);
        playTone(659, 0.08, 0.1, 'triangle', 0.04);
      }
      wasOnFootrest = !!g.footrest && !carAirborne;

      // Objeto seguro é arrastado atrás do carrinho
      if (heldItem) {
        // Distância do arrasto respeita o tamanho do objeto (antes objetos grandes ficavam dentro do carrinho)
        const heldR = heldItem.obs ? heldItem.obs.r : 1;
        const dragDist = Math.max(heldItem.type === 'pencil' ? 3.4 : 3.2, 2.1 + heldR + 0.4);
        const dragX = nextX - Math.sin(carAngle) * dragDist;
        const dragZ = nextZ - Math.cos(carAngle) * dragDist;
        heldItem.group.position.set(dragX, y - CAR_DESK_Y + itemRestOffset(heldItem) + 0.35, dragZ);
        heldItem.group.rotation.y = carAngle;
        if (heldItem.type === 'pencil' && Math.abs(carSpeed) > 0.01) {
          // Pinta a pista onde o lápis passar (mesa, rampas e chão); fora da pista, na mesa, vira rabisco livre
          drawWithPencil(heldItem, dragX, y, dragZ, dt);
        }
        if (heldItem.onDrag) heldItem.onDrag();
        if (heldItem.clipBox) dropClipsWhileDragging(heldItem);
      }

      // Inclinação: veículo alinhado ao terreno (rampa) + carroceria com squat/lean
      let targetPitch = 0, targetRoll = 0;
      if (carOnRamp && nextX < -DESK_HALF_W && nextX > -DESK_HALF_W - 45) {
        targetPitch = -Math.atan(RAMP_SLOPE * Math.sin(carAngle));
        targetRoll = Math.atan(RAMP_SLOPE * Math.cos(carAngle));
      } else if (g.footrest && !carAirborne) {
        // Inclinação realista na rampa sob a mesa conforme a seção atual (subida, meio e descida)
        let slopeZ = 0;
        if (nextZ < FOOTREST.z0) {
          slopeZ = (footrestTopAt(FOOTREST.z0) + 0.15) / (FOOTREST.z0 - FOOTREST.zStart);
        } else if (nextZ <= FOOTREST.z1) {
          slopeZ = Math.tan(0.38);
        } else {
          slopeZ = -(footrestTopAt(FOOTREST.z1) + 0.15) / (FOOTREST.zEnd - FOOTREST.z1);
        }
        targetPitch = -Math.atan(slopeZ * Math.cos(carAngle));
        targetRoll = -Math.atan(slopeZ * Math.sin(carAngle));
      } else if (g.rallyObs && !carAirborne) {
        // Terreno do rally: inclina conforme a altura sob a frente/traseira e os lados
        const fx = Math.sin(carAngle), fz = Math.cos(carAngle), rx = Math.cos(carAngle), rz = -Math.sin(carAngle);
        const hF = rallyHeightAt(nextX + fx * 1.5, nextZ + fz * 1.5), hB = rallyHeightAt(nextX - fx * 1.5, nextZ - fz * 1.5);
        const hR = rallyHeightAt(nextX + rx * 1.1, nextZ + rz * 1.1), hL = rallyHeightAt(nextX - rx * 1.1, nextZ - rz * 1.1);
        targetPitch = -Math.atan2(hF - hB, 3.0);
        targetRoll = Math.atan2(hR - hL, 2.2);
        // Capota de lado só se ficar inclinado demais por ~0,25 s seguidos (antes bastava um quadro)
        bajaSideTilt = Math.abs(targetRoll) > 0.7 && Math.abs(carSpeed) > 0.18 ? bajaSideTilt + dt : 0;
        if (isBajaCar && bajaSideTilt > 0.25) { bajaSideTilt = 0; startBajaFlip('side', Math.sign(targetRoll), true); }
      } else if ((g.elevated || g.terrain) && !carAirborne) {
        // Ponte, cume da montanha e encostas: inclina pela altura do terreno à frente/atrás e dos lados
        const fx = Math.sin(carAngle), fz = Math.cos(carAngle), rx = Math.cos(carAngle), rz = -Math.sin(carAngle);
        const hc = groundY - FLOOR_CAR_Y;
        const hAt = (px, pz) => { const r = bajaRallyGround(px, pz, groundY); return r && !r.wall && !r.lake ? r.y - FLOOR_CAR_Y : hc; };
        targetPitch = -Math.atan2(hAt(nextX + fx * 1.5, nextZ + fz * 1.5) - hAt(nextX - fx * 1.5, nextZ - fz * 1.5), 3.0);
        targetRoll = Math.atan2(hAt(nextX + rx * 1.1, nextZ + rz * 1.1) - hAt(nextX - rx * 1.1, nextZ - rz * 1.1), 2.2);
      } else if (carAirborne && !isSomersaulting) {
        targetPitch = clamp(-fallVelocityY * 1.1, -0.35, 0.55);
      }
      carPitch += (targetPitch - carPitch) * 0.25;
      carRoll += (targetRoll - carRoll) * 0.25;
      vehicle.rotation.set(carPitch, carAngle, carRoll);

      if (isSomersaulting) {
        // Mortal para trás em torno do centro da carroceria
        somersaultAngle = Math.min(Math.PI * 2, somersaultAngle + dt * (Math.PI * 2 / 0.62));
        const h = 1.2;
        carBodyGroup.rotation.set(-somersaultAngle, 0, 0);
        carBodyGroup.position.set(0, h * (1 - Math.cos(somersaultAngle)), h * Math.sin(somersaultAngle));
        if (somersaultAngle >= Math.PI * 2 && !carAirborne) {
          isSomersaulting = false;
          carBodyGroup.rotation.set(0, 0, 0);
          carBodyGroup.position.set(0, 0, 0);
        }
      } else {
        carBodyGroup.rotation.x += (-carSpeed * 0.25 - carBodyGroup.rotation.x) * 0.3;
        carBodyGroup.rotation.z = (kL ? 0.06 : kR ? -0.06 : 0) * (Math.abs(carSpeed) / currentMaxSpeed);
      }

      if (bajaBodyGroup) {
        bajaBodyGroup.rotation.copy(carBodyGroup.rotation);
        bajaBodyGroup.position.copy(carBodyGroup.position);
        stepBajaFlip(dt);
      }

      const mudSpin = g.mud && !isBajaCar && (kF || kB) ? (kF ? 0.55 : -0.55) : 0;
      wheels.forEach((w, idx) => {
        w.rotation.x += carSpeed * 1.9 + mudSpin;
        if (idx < 2) w.rotation.y = steer * 0.35;
      });
      if (isBajaCar) {
        updateBajaVisual(carSpeed, steer, y - curY, !!g.rallyObs || !!g.mud || !!g.terrain);
        if (Math.abs(bajaDirt - lastDirtApplied) > 0.02) { lastDirtApplied = bajaDirt; applyBajaDirt(); }
      }
    }

    // Deslocamento de ar do carrinho: objetos leves (lápis, clipes, cones, chupeta...) são soprados para o lado
    function windWakePush(obs) {
      const sp = Math.abs(carSpeed);
      if (sp < 0.05 || obs.level !== levelOfY(vehicle.position.y)) return;
      const dx = obs.x - vehicle.position.x, dz = obs.z - vehicle.position.z;
      const R = 3.2 + sp * 8, d2 = dx * dx + dz * dz;
      if (d2 > R * R) return;
      const d = Math.sqrt(d2) || 0.001, fall = (1 - d / R) * (1 - d / R);
      const sg = carSpeed >= 0 ? 1 : -1, hx = Math.sin(carAngle) * sg, hz = Math.cos(carAngle) * sg;
      const along = dx * hx + dz * hz;
      let sx = dx - hx * along, sz = dz - hz * along;
      const sl = Math.hypot(sx, sz) || 1;
      const a = sp * fall * 0.006 / Math.max(0.1, obs.mass);
      obs.vx += (sx / sl * 0.8 + hx * 0.4) * a;
      obs.vz += (sz / sl * 0.8 + hz * 0.4) * a;
      obs.vRotY += (Math.random() - 0.5) * a * 0.6;
    }

    // Física dos objetos: deslizamento, tombamento, queda da mesa, paredes e colisões entre objetos
    // ============================================================================
    // GRADE ESPACIAL (fase ampla) + OBJETOS "DORMINDO"
    // Antes: todos os pares objeto×objeto (≈14 mil) e objeto×fixo (≈100 mil) a cada passo = ~9 ms.
    // Agora: cada objeto só testa vizinhos da mesma célula; objetos parados e longe do carrinho dormem.
    // ============================================================================
    const GRID_CELL = 8;
    const staticGrid = new Map();
    let staticGridCount = -1;
    const dynGrid = new Map();
    let gridStamp = 1;
    const obsExtent = (o) => (o.box ? Math.hypot(o.box.hx, o.box.hz) : o.r);
    function gridInsert(map, o, lvl, e) {
      const x0 = Math.floor((o.x - e) / GRID_CELL), x1 = Math.floor((o.x + e) / GRID_CELL);
      const z0 = Math.floor((o.z - e) / GRID_CELL), z1 = Math.floor((o.z + e) / GRID_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = lvl + cx + ',' + cz;
        let arr = map.get(k);
        if (!arr) { arr = []; map.set(k, arr); }
        arr.push(o);
      }
    }
    // Obstáculos fixos: grade montada uma vez (refeita só quando a lista muda, ex.: modelos carregando)
    function ensureStaticGrid() {
      if (staticGridCount === obstacles.length) return;
      staticGrid.clear();
      for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        if (o._dyn) continue;
        gridInsert(staticGrid, o, o.level === 'floor' ? 'f' : 'd', obsExtent(o) + 0.5);
      }
      staticGridCount = obstacles.length;
    }
    function forEachNear(map, lvl, x, z, r, cb) {
      const stamp = ++gridStamp;
      const L = lvl === 'floor' ? 'f' : 'd';
      const x0 = Math.floor((x - r) / GRID_CELL), x1 = Math.floor((x + r) / GRID_CELL);
      const z0 = Math.floor((z - r) / GRID_CELL), z1 = Math.floor((z + r) / GRID_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const arr = map.get(L + cx + ',' + cz);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const o = arr[i];
          if (o._gs === stamp) continue;
          o._gs = stamp;
          if (cb(o) === true) return true;
        }
      }
      return false;
    }
    function rebuildDynGrid() {
      dynGrid.clear();
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const o = dynamicObstacles[i];
        o._idx = i;
        if (o.isFalling || (heldItem && heldItem.obs === o) || o.r < 0.01) continue;
        gridInsert(dynGrid, o, o.level === 'floor' ? 'f' : 'd', obsExtent(o));
      }
    }
    // Dorme: parado, sem inclinação/quique/queda e longe do carrinho (o carrinho sempre acorda quem está perto)
    function dynIsAsleep(o, cp) {
      if (o.isFalling || o.vx || o.vz || o.vRotY || o.tiltX || o.tiltZ || o.hop || o.hopV) return false;
      if (o.stackOffset > 0 || (o.pin && o.knocked && o.knockT < 1) || o.onRamp || o.ball) return false;
      const dx = o.x - cp.x, dz = o.z - cp.z, r = 16 + obsExtent(o);
      return dx * dx + dz * dz > r * r;
    }

    function stepDynamicObjects() {
      ensureStaticGrid();
      rebuildDynGrid();
      const cpos = vehicle.position;
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const o = dynamicObstacles[i];
        o._sleep = dynIsAsleep(o, cpos);
      }
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const obs = dynamicObstacles[i];
        const grp = obs.group;
        if (!grp || (heldItem && heldItem.obs === obs) || obs._sleep) continue;
        if (obs.mass <= 0.5 && !obs.ball && !obs.pin && !obs.isFalling) windWakePush(obs);

        // Empurrado para fora da mesa -> cai até o chão (antes podia congelar no ar)
        // (bolas que entram na rampa de papelão NÃO caem: rolam pela rampa)
        if (!obs.isFalling && obs.level === 'desk' && !(obs.ball && rampZoneAt(obs.x, obs.z)) &&
            (Math.abs(obs.x) > DESK_HALF_W + 0.6 || Math.abs(obs.z) > DESK_HALF_D + 0.6)) {
          obs.isFalling = true;
          obs.vy = 0;
          obs.stackOffset = 0;
        }
        if (obs.isFalling) {
          obs.vy -= GRAVITY;
          grp.position.y += obs.vy;
          const floorY = FLOOR_SURFACE_Y + (obs.restOffset || 0);
          if (grp.position.y <= floorY) {
            grp.position.y = floorY;
            obs.isFalling = false;
            obs.vy = 0;
            obs.level = 'floor';
            obs.vx *= 0.35;
            obs.vz *= 0.35;
            if (obs.canTopple) obs.tiltX += 0.25;
            if (obs.ball) obs.hopV = 0.3; // a bola quica ao chegar no chão
            if (obs.burstBox) burstBox(obs, obs.vx || Math.random() - 0.5, obs.vz || Math.random() - 0.5, 0.6); // caiu da mesa: abre
          }
        }

        const moving = Math.abs(obs.vx) > 1e-4 || Math.abs(obs.vz) > 1e-4 || Math.abs(obs.vRotY) > 1e-4;
        if (moving) {
          // Atrito por objeto: bolas rolam longe, caixas e tijolos param rápido
          const fr = obs.friction || 0.91;
          obs.x += obs.vx;
          obs.z += obs.vz;
          obs.vx *= fr;
          obs.vz *= fr;
          obs.vRotY *= 0.88;
          if (!obs.pin) grp.rotation.y += obs.vRotY;
        } else {
          obs.vx = 0; obs.vz = 0; obs.vRotY = 0;
        }

        // Paredes do quarto também seguram os objetos (bola quica com mais energia)
        if (obs.level === 'floor') {
          const r = obs.box ? Math.max(obs.box.hx, obs.box.hz) : obs.r, e = obs.wallE || (obs.ball ? 0.75 : 0.4);
          if (obs.x < BOUNDS.minX - 2 + r) { obs.x = BOUNDS.minX - 2 + r; obs.vx = Math.abs(obs.vx) * e; }
          if (obs.x > BOUNDS.maxX + 1 - r) { obs.x = BOUNDS.maxX + 1 - r; obs.vx = -Math.abs(obs.vx) * e; }
          if (obs.z < BOUNDS.minZ - 2 + r) { obs.z = BOUNDS.minZ - 2 + r; obs.vz = Math.abs(obs.vz) * e; }
          if (obs.z > BOUNDS.maxZ + 2 - r) { obs.z = BOUNDS.maxZ + 2 - r; obs.vz = -Math.abs(obs.vz) * e; }
        }

        // Bolas na rampa de papelão: altura acompanha a rampa, gravidade puxa para baixo,
        // abas laterais seguram e o nível (mesa/chão) muda conforme a altura — dá para levar a bola até a mesa
        const rampZoneObs = (obs.ball && !obs.isFalling) ? rampZoneAt(obs.x, obs.z) : null;
        obs.onRamp = !!rampZoneObs && obs.x < -DESK_HALF_W && obs.x > -DESK_HALF_W - 45;
        let rampBase = null;
        if (obs.onRamp) {
          const h = rampHeightAt(obs.x);
          rampBase = surfaceBaseY(0) + (h - CAR_DESK_Y);
          obs.level = levelOfY(h);
          // Componente da gravidade ao longo da rampa (esfera rolando: ~5/7 de g·sen·cos)
          obs.vx -= GRAVITY * 0.34;
          const zMin = (rampZoneObs === 'down' ? 10.8 : 30.8) + obs.r, zMax = (rampZoneObs === 'down' ? 25.2 : 45.2) - obs.r;
          if (obs.z < zMin) { obs.z = zMin; obs.vz = Math.abs(obs.vz) * 0.5; }
          if (obs.z > zMax) { obs.z = zMax; obs.vz = -Math.abs(obs.vz) * 0.5; }
        } else if (obs.ball && !obs.isFalling && obs.x >= -DESK_HALF_W && obs.x < -DESK_HALF_W + 2.5 && rampZoneObs) {
          obs.level = 'desk'; // chegou no topo da rampa: agora está na mesa
        }
        // Terreno sob o objeto: no quarto soma o gramado das ilhas (sai da ilha = desce; sobe ao entrar)
        const terrainY = rampBase !== null ? rampBase
          : obs.level === 'desk' ? surfaceBaseY(0) : FLOOR_SURFACE_Y + Math.max(0, floorExtraHeight(obs.x, obs.z));
        const baseY = terrainY + (obs.restOffset || 0);
        if (!obs.isFalling && obs.level === 'floor' && !obs.pin && !(obs.stackOffset > 0) && !(obs.hop > 0) && !obs.hopV) {
          grp.position.y = baseY;
        }
        if (!obs.isFalling) {
          // Quique vertical com perda de energia (bola sempre; outros objetos após batidas fortes)
          if (!obs.pin && !(obs.stackOffset > 0) && (obs.ball || obs.hopV || obs.hop)) {
            obs.hop = obs.hop || 0;
            obs.hopV = (obs.hopV || 0) - GRAVITY;
            obs.hop += obs.hopV;
            if (obs.hop <= 0) {
              obs.hop = 0;
              obs.hopV = obs.hopV < -0.06 ? -obs.hopV * (obs.bounce || 0.5) : 0;
            }
            grp.position.y = baseY + obs.hop;
          }
          // Tijolos empilhados caem quando o muro é empurrado
          if (obs.stackOffset > 0) {
            if (moving) obs.stackDropping = true;
            // Sem tijolo embaixo (foi arrancado pelo carrinho): o de cima cai
            if (!obs.stackDropping && obs.box) {
              const myBottom = grp.position.y;
              const supported = forEachNear(dynGrid, obs.level, obs.x, obs.z, obs.box.hx * 1.45, (o) => o !== obs && o.box && o.group &&
                Math.abs(o.group.position.y + (o.h || 0) - myBottom) < 0.25 &&
                Math.hypot(o.x - obs.x, o.z - obs.z) < obs.box.hx * 1.45);
              if (!supported) obs.stackDropping = true;
            }
            if (obs.stackDropping) obs.stackOffset = Math.max(0, obs.stackOffset - 0.09);
            grp.position.y = baseY + obs.stackOffset;
          }
          // Pino derrubado: tomba até ficar deitado
          if (obs.pin && obs.knocked && obs.knockT < 1) {
            obs.knockT = Math.min(1, obs.knockT + 0.07);
            const ease = 1 - Math.pow(1 - obs.knockT, 3);
            grp.quaternion.setFromAxisAngle(obs.knockAxis, Math.PI / 2 * ease);
            grp.position.y = baseY + 0.7 * ease;
          }
        }

        if (!obs.pin && (obs.tiltX || obs.tiltZ)) {
          obs.tiltX *= 0.86;
          obs.tiltZ *= 0.86;
          if (Math.abs(obs.tiltX) < 1e-3) obs.tiltX = 0;
          if (Math.abs(obs.tiltZ) < 1e-3) obs.tiltZ = 0;
          grp.rotation.x = obs.tiltX;
          grp.rotation.z = obs.tiltZ;
        }
      }

      // Objeto x objeto (troca de momento com restituição) e objeto x obstáculo fixo
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const a = dynamicObstacles[i];
        if (a.isFalling || (heldItem && heldItem.obs === a) || a._sleep) continue;
        const near = [];
        forEachNear(dynGrid, a.level, a.x, a.z, obsExtent(a), (b) => { near.push(b); });
        for (let j = 0; j < near.length; j++) {
          const b = near[j];
          // Cada par uma vez só: dois acordados → o de menor índice resolve; acordado × dormindo → o acordado resolve
          if (b === a || b.isFalling || b.level !== a.level || (heldItem && heldItem.obs === b)) continue;
          if (!b._sleep && b._idx < a._idx) continue;
          // Fase ampla: raio envolvente (caixas usam a meia-diagonal)
          const ra = a.box ? Math.hypot(a.box.hx, a.box.hz) : a.r, rb = b.box ? Math.hypot(b.box.hx, b.box.hz) : b.r;
          if (Math.hypot(b.x - a.x, b.z - a.z) >= ra + rb || a.r < 0.01 || b.r < 0.01) continue;
          // Só colidem se estiverem na mesma altura (tijolo de outra fileira do muro não empurra o de baixo)
          const sa = dynVerticalSpan(a), sb = dynVerticalSpan(b);
          if (sa[1] - 0.08 <= sb[0] || sb[1] - 0.08 <= sa[0]) continue;
          // Forma real: caixa x caixa (SAT), caixa x círculo ou círculo x círculo
          const contact = dynPairContact(a, b);
          if (!contact) continue;
          const nx = contact.nx, nz = contact.nz;
          const overlap = contact.overlap;
          const ma = a.mass || 1, mb = b.mass || 1;
          a.x -= nx * overlap * mb / (ma + mb);
          a.z -= nz * overlap * mb / (ma + mb);
          b.x += nx * overlap * ma / (ma + mb);
          b.z += nz * overlap * ma / (ma + mb);
          const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
          if (closing > 0) {
            const e = (a.ball || b.ball) ? Math.max(a.restitution || 0.3, b.restitution || 0.3) : 0.3;
            const j2 = (1 + e) * closing / (1 / ma + 1 / mb);
            // Impulso no ponto de contato: batida de quina faz a caixa/tijolo girar
            applyDynImpulse(a, -j2 * nx, -j2 * nz, contact.px, contact.pz, 0.6);
            applyDynImpulse(b, j2 * nx, j2 * nz, contact.px, contact.pz, 0.6);
            // Pinos tombam quando algo bate neles com força (bola, outro pino, caixa)
            if (closing > 0.03) {
              if (b.pin) knockPin(b, nx, nz);
              if (a.pin) knockPin(a, -nx, -nz);
            }
          }
          if (a.group) { a.group.position.x = a.x; a.group.position.z = a.z; }
          if (b.group) { b.group.position.x = b.x; b.group.position.z = b.z; }
          b._sleep = false; // quem levou um empurrão acorda
        }
        const nearStatic = [];
        forEachNear(staticGrid, a.level, a.x, a.z, a.r, (st) => { nearStatic.push(st); });
        for (let k = 0; k < nearStatic.length; k++) {
          const s = nearStatic[k];
          if (s._dyn || (s.level || 'desk') !== a.level || s.y0 !== undefined) continue;
          const dx = a.x - s.x, dz = a.z - s.z;
          const d = Math.hypot(dx, dz);
          const minD = a.r + s.r;
          if (d >= minD || d < 1e-4) continue;
          const nx = dx / d, nz = dz / d;
          a.x = s.x + nx * minD;
          a.z = s.z + nz * minD;
          const vn = a.vx * nx + a.vz * nz;
          const e = 1 + (a.wallE || (a.ball ? 0.7 : 0.4));
          if (vn < 0) { a.vx -= e * vn * nx; a.vz -= e * vn * nz; }
          if (a.group) { a.group.position.x = a.x; a.group.position.z = a.z; }
        }
      }

      // Objetos em movimento também não atravessam o carrinho (ex.: bola rolando contra ele parado)
      const cp = vehicle.position;
      const carLvl = levelOfY(cp.y);
      const carH = carOnRamp ? cp.y - rampHeightAt(cp.x) : cp.y - (surfaceBaseY(cp.y) + CAR_DESK_Y);
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const o = dynamicObstacles[i];
        const ext = obsExtent(o) + 4;
        if (Math.abs(o.x - cp.x) > ext || Math.abs(o.z - cp.z) > ext) continue;
        if (!obstacleCollidesWithCar(o, carLvl, carH)) continue;
        const contact = carContact(o, cp.x, cp.z, carAngle);
        if (!contact) continue;
        // Normal do contato aponta para o carrinho: o objeto sai no sentido oposto
        const nx = -contact.nx, nz = -contact.nz;
        const ox = o.x + nx * contact.overlap, oz = o.z + nz * contact.overlap;
        if (!(o.heavy && !carHeavyPush) && !dynamicObjectBlockedAt(o, ox, oz)) { o.x = ox; o.z = oz; }
        else {
          // Objeto preso (parede/fixo): o carrinho recua imediatamente, nunca fica sobreposto
          cp.x += contact.nx * (contact.overlap + 0.01);
          cp.z += contact.nz * (contact.overlap + 0.01);
        }
        const vn = o.vx * nx + o.vz * nz;
        if (vn < 0) {
          const e = 1 + (o.ball ? (o.restitution || 0.5) : 0.3);
          o.vx -= e * vn * nx; o.vz -= e * vn * nz;
          if (o.ball && -vn > 0.15) o.hopV = Math.max(o.hopV || 0, Math.min(0.3, -vn * (o.lift || 0)));
          playImpactSound(o, -vn, o.mass || 1);
        }
        if (o.group) { o.group.position.x = o.x; o.group.position.z = o.z; }
      }
      // Correção final combinada: fixos empurram o carrinho; móveis saem do caminho se puderem
      // (senão o carrinho recua). Repete até não sobrar sobreposição com NADA.
      const nearCar = obstacles.filter((s) => { const e = obsExtent(s) + 5; return Math.abs(s.x - cp.x) < e && Math.abs(s.z - cp.z) < e; });
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        for (let i = 0; i < nearCar.length; i++) {
          const s = nearCar[i];
          if (!obstacleCollidesWithCar(s, carLvl, carH)) continue;
          const c = carContact(s, cp.x, cp.z, carAngle);
          if (!c || c.overlap < 0.005) continue;
          if (s._dyn) {
            const ox = s.x - c.nx * c.overlap, oz = s.z - c.nz * c.overlap;
            if (!(s.heavy && !carHeavyPush) && !dynamicObjectBlockedAt(s, ox, oz) && !dynamicOverlapsOtherDynamic(s, ox, oz)) {
              s.x = ox; s.z = oz;
              if (s.group) { s.group.position.x = s.x; s.group.position.z = s.z; }
              moved = true;
              continue;
            }
          }
          cp.x += c.nx * (c.overlap + 0.01);
          cp.z += c.nz * (c.overlap + 0.01);
          moved = true;
        }
        if (!moved) break;
      }
    }

    function stepWaterDrops(time) {
      if (keys.spray && !inputBlocked() && Math.random() > 0.45) spawnWaterJet();
      for (let i = waterDrops.length - 1; i >= 0; i--) {
        const d = waterDrops[i];
        d.mesh.position.add(d.vel);
        d.vel.y -= 0.02;
        d.life--;
        const onDesk = d.groundY > -15;

        growablePlants.forEach((p) => {
            if (p.level >= 2 || !!p.onFloor === onDesk) return; // só rega plantas do mesmo nível da gota
            if (Math.hypot(d.mesh.position.x - p.x, d.mesh.position.z - p.z) < 3.5) {
              if (!p.isWatered) {
                p.isWatered = true;
                logInteractionEvent(`🌱 ${p.name} regada! Crescendo gradualmente (3 min)...`);
                trackAchievementSet('gardener', p.name);
              }
              p.growthElapsed = Math.min(PLANT_GROWTH_DURATION, p.growthElapsed + 0.08);
              if (time - lastPlantSpeechTime > 3.5) {
                lastPlantSpeechTime = time;
                showCarSpeech('plantinhas felizes', 2600);
              }
            }
          });

          if (onDesk && monitorState === 'burning' && Math.hypot(d.mesh.position.x - 6.5, d.mesh.position.z + 11.5) < 13.0) {
            selfDestructProgress = Math.max(0, selfDestructProgress - 3.8);
            if (selfDestructProgress <= 0) {
              monitorState = 'normal';
              monitorFireGroup.visible = false;
              fireLight.intensity = 0;
              typedTextLines.push('> FIRE EXTINGUISHED! SYSTEM SAVED.');
              updateMonitorScreen();
              showCarSpeech('eeeee parabens pro Ravi', 3800);
              setStatusBanner('🧯 INCÊNDIO APAGADO! Parabéns pro Ravi!', '#7ee787');
              logInteractionEvent('🧯 Incêndio apagado! "eeeee parabens pro Ravi"');
              notify({ type: 'success', title: 'Incêndio apagado!', description: 'O monitor foi salvo. Parabéns, Ravi!' });
              unlockAchievement('firefighter');
            }
          }

        if (d.mesh.position.y < d.groundY || d.life <= 0) {
          scene.remove(d.mesh);
          waterDrops.splice(i, 1);
        }
      }
    }

    function stepSparks() {
      for (let i = turboSparks.length - 1; i >= 0; i--) {
        const sp = turboSparks[i];
        sp.mesh.position.add(sp.vel);
        sp.life--;
        sp.mesh.scale.setScalar(Math.max(0.001, sp.life / 22));
        if (sp.life <= 0) {
          scene.remove(sp.mesh);
          turboSparks.splice(i, 1);
        }
      }
    }

    // Conquista secreta: alguma bola (vôlei ou boliche) chegou à mesa, perto do aquário
    function checkBallOnDesk() {
      if (achievementState.unlocked.ballDesk) return;
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const o = dynamicObstacles[i];
        if (!o.ball || o.level !== 'desk' || o.onRamp || o.isFalling) continue;
        if (Math.hypot(o.x - AQ_X, o.z - AQ_Z) < 24) {
          unlockAchievement('ballDesk');
          confettiBurst(o.x, 3, o.z, 60);
          showCarSpeech('Gol de placa! ⚽', 2200);
          return;
        }
      }
    }
    // ============================================================================
    // PORTAS ENTRE CENÁRIOS — cada cenário é uma página; ao chegar na porta, um popup pergunta se quer ir
    // ============================================================================
    const doorModalTitle = document.getElementById('door-title'), doorModalText = document.getElementById('door-text');
    const doorGoBtn = document.getElementById('door-go'), doorStayBtn = document.getElementById('door-stay');
    let doorTargetHref = null;
    function openDoorPopup(d) {
      doorModalTitle.textContent = d.title;
      doorModalText.textContent = d.text;
      doorTargetHref = d.href || null;
      doorGoBtn.style.display = d.href ? '' : 'none';
      doorGoBtn.querySelector('span').textContent = d.goLabel || 'Ir';
      doorStayBtn.querySelector('span').textContent = d.href ? (d.stayLabel || 'Ficar aqui') : 'Ok';
      carSpeed = 0;
      sfx('uiOpen', { vol: 0.45 });
      openModalPanel('door');
    }
    doorGoBtn.addEventListener('click', () => { if (doorTargetHref) { saveAchievements(); location.href = doorTargetHref; } });
    doorStayBtn.addEventListener('click', () => closeModals());
    document.querySelector('#modal-door .close').addEventListener('click', () => closeModals());
    const DOORS = [];
    function doorwayVisual({ x, z, rotY, w, h, label, outside }) {
      const g = new THREE.Group();
      g.position.set(x, FLOOR_SURFACE_Y, z);
      g.rotation.y = rotY;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.6 });
      [[-w / 2 - 0.35, h / 2, 0.7, h], [w / 2 + 0.35, h / 2, 0.7, h]].forEach(([fx, fy, fw, fh]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 1.2), frameMat); m.position.set(fx, fy, 0); g.add(m); });
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.7, 1.2), frameMat); top.position.set(0, h + 0.35, 0); g.add(top);
      // Vão aberto: o que se vê do outro lado (gradiente de "outro cômodo" ou do quintal)
      const c = document.createElement('canvas'); c.width = 64; c.height = 128;
      const x2 = c.getContext('2d'); const gr = x2.createLinearGradient(0, 0, 0, 128);
      (outside ? [['0', '#9fd3f2'], ['0.62', '#d9f0ff'], ['0.64', '#6fae4a'], ['1', '#4f8a35']] : [['0', '#3a3346'], ['1', '#15121b']]).forEach(([o, col]) => gr.addColorStop(+o, col));
      x2.fillStyle = gr; x2.fillRect(0, 0, 64, 128);
      const opening = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
      opening.position.set(0, h / 2, 0.55); g.add(opening);
      // Folha da porta aberta encostada na parede
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.5), new THREE.MeshStandardMaterial({ color: outside ? 0x8a5a2f : 0xd8cfc0, roughness: 0.6 }));
      leaf.position.set(-w / 2 - 0.3, h / 2, -w / 2 - 0.4); leaf.rotation.y = Math.PI / 2 - 0.15; g.add(leaf);
      scene.add(g);
      const lbl = createIslandLabel(label, 0, 0, 0); lbl.position.set(arguments[0].tx, FLOOR_SURFACE_Y + h + 4, arguments[0].tz); lbl.scale.set(11, 2.2, 1); // dentro do cômodo (não atravessa a parede)
      return g;
    }
    function addDoor(d) { DOORS.push(Object.assign({ inside: false }, d)); doorwayVisual(d); }
    function updateDoors() {
      if (introActive || modalsOpen || menuOpen) return;
      const p = vehicle.position;
      DOORS.forEach((d) => {
        const near = p.y < -15 && Math.hypot(p.x - d.tx, p.z - d.tz) < d.r;
        if (near && !d.inside) openDoorPopup(d);
        d.inside = near;
      });
    }
    if (IS_QUARTO) {
      // Porta da frente: aberta, com um ramal da pista até ela — a sala está em reforma
      addDoor({ x: -90, z: 92.6, rotY: Math.PI, w: 9, h: 22, label: 'Sala 🚧', tx: -90, tz: 86, r: 6,
        title: 'Sala em reforma 🚧', text: 'O Ravi ainda está arrumando a sala. Volte mais tarde para conhecer o próximo cenário!' });
      buildTrackRibbon([[-104, -35.815, 55], [-99, -35.815, 63], [-94, -35.815, 73], [-91, -35.815, 82], [-90, -35.815, 89]], 7);
      // Porta do quintal: parede leste
      addDoor({ x: 237.6, z: 30, rotY: -Math.PI / 2, w: 12, h: 24, label: 'Quintal 🌳', tx: 230, tz: 30, r: 7, outside: true, href: 'quintal.html',
        title: 'Ir para o quintal? 🌳', text: 'Lá fora fica o rally do Baja 13: lama, ponte, montanha da cachoeira, fogueira e muito verde.', goLabel: 'Ir para o quintal', stayLabel: 'Ficar no quarto' });
    } else {
      // Porta dos fundos da casa: volta para o quarto
      addDoor({ x: 119.6, z: 20, rotY: Math.PI / 2, w: 12, h: 24, label: 'Casa 🏠', tx: 127, tz: 20, r: 6.5, href: 'index.html',
        title: 'Voltar para o quarto? 🏠', text: 'A mesa, o circuito, as ilhas e o caminhãozinho do Ravi estão lá dentro.', goLabel: 'Entrar em casa', stayLabel: 'Ficar no quintal' });
    }

    // ============================================================================
    // QUINTAL: gramado, cerca de madeira, fachada dos fundos da casa; e retira o que é do quarto
    // ============================================================================
    if (IS_QUINTAL) {
      // Gramado com manchas de terra
      const tex = (() => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const x = c.getContext('2d');
        x.fillStyle = '#6fae4a'; x.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 900; i++) {
          const px = Math.random() * 256, py = Math.random() * 256, r = 2 + Math.random() * 10;
          x.fillStyle = ['rgba(90,150,60,0.5)', 'rgba(130,190,80,0.45)', 'rgba(70,120,45,0.4)', 'rgba(150,110,70,0.18)'][i % 4];
          x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
        }
        const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(18, 14);
        return t;
      })();
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 200), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(232, FLOOR_SURFACE_Y - 0.02, 10); ground.receiveShadow = true;
      scene.add(ground);
      // Fachada dos fundos da casa (parede oeste) com janelas
      const house = new THREE.Mesh(new THREE.BoxGeometry(6, 60, 200), new THREE.MeshStandardMaterial({ color: 0xf2e6cf, roughness: 0.85 }));
      house.position.set(115, FLOOR_SURFACE_Y + 30, 10); house.receiveShadow = true; house.userData.quintal = true; scene.add(house);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 3, 204), new THREE.MeshStandardMaterial({ color: 0xb5503a, roughness: 0.8 }));
      roof.position.set(116, FLOOR_SURFACE_Y + 61, 10); roof.userData.quintal = true; scene.add(roof);
      [-60, -25, 60].forEach((wz) => {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), new THREE.MeshStandardMaterial({ color: 0xbfe6ff, roughness: 0.1, metalness: 0.2, emissive: 0x335577, emissiveIntensity: 0.2 }));
        win.position.set(118.1, FLOOR_SURFACE_Y + 24, wz); win.rotation.y = Math.PI / 2; scene.add(win);
        const sill = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 15), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        sill.position.set(118.6, FLOOR_SURFACE_Y + 17.6, wz); scene.add(sill);
      });
      // Cerca de madeira da Kenney (instanciada) nos outros três lados
      loadKenney('nature-kit', 'fence_planks').then((proto) => {
        proto.updateMatrixWorld(true);
        const spots = [];
        const L = 9;
        for (let x = 121 + L / 2; x < 340; x += L) { spots.push([x, -80.5, 0]); spots.push([x, 100.5, Math.PI]); }
        for (let z = -80 + L / 2; z < 100; z += L) spots.push([340.5, z, -Math.PI / 2]);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(L, 9, 9), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        proto.traverse((o) => {
          if (!o.isMesh) return;
          const im = new THREE.InstancedMesh(o.geometry, o.material, spots.length);
          spots.forEach(([x, z, r], i) => {
            m4.compose(pos.set(x, FLOOR_SURFACE_Y, z), q.setFromAxisAngle(up, r), sc).multiply(o.matrixWorld);
            im.setMatrixAt(i, m4);
          });
          im.castShadow = true; im.receiveShadow = true;
          scene.add(im);
        });
      });
      // Natureza do Quaternius (CC0): árvores, arbustos e flores espalhados longe da pista, instanciados por modelo
      const rnd = (() => { let s = 913; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
      const used = [];
      const free = (x, z, r) => x > 127 && x < 336 && z > -76 && z < 96 &&
        rallyNearest(x, z).dist > RALLY_SIDE + r + 2 && mountainH(x, z) < 0.05 &&
        Math.hypot(x - 185, z - 64) > 16 + r && Math.hypot(x - 152, z - 70) > 15 + r &&
        Math.hypot(x - POND.x, z - POND.z) > POND.r + 3 + r && Math.hypot(x - 122, z - 20) > 14 && Math.hypot(x - 133, z - 47) > 15 + r &&
        used.every((u) => Math.hypot(x - u[0], z - u[1]) > u[2] + r);
      const scatter = (names, count, height, r, collide) => {
        const spots = names.map(() => []);
        for (let tries = 0, n = 0; n < count && tries < count * 60; tries++) {
          const x = 127 + rnd() * 209, z = -76 + rnd() * 172;
          if (!free(x, z, r)) continue;
          used.push([x, z, r]); spots[n % names.length].push([x, z, rnd() * Math.PI * 2, height * (0.8 + rnd() * 0.45)]); n++;
          if (collide) obstacles.push({ x, z, r: collide, h: height, isStatic: true, level: 'floor', name: 'ÁRVORE' });
        }
        names.forEach((nm, i) => spots[i].length && placeInstanced('./models/quaternius/' + nm + '.glb', spots[i]));
      };
      scatter(['MapleTree_1', 'MapleTree_2', 'MapleTree_3'], 9, 20, 6, 1.4);
      scatter(['BirchTree_1', 'BirchTree_2', 'DeadTree_1'], 8, 18, 3.5, 0.9);
      scatter(['Bush', 'Bush_Flowers', 'Bush_Large_Flowers', 'Bush_Small_Flowers'], 26, 3.6, 2.2, 0);
      scatter(['Flower_1_Clump', 'Flower_3_Clump', 'Flower_4_Clump'], 45, 1.6, 0.9, 0);
      // Ilha do 86: Toyota AE86 ("Toyota AE86" por IvOfficial, poly.pizza, CC-BY 3.0) + painel sobre Initial D + Shiba
      const AE86 = { x: 133, z: 47 };
      createIsland({
        id: 'ae86', name: 'Ilha do 86 · Hachi-Roku', label: 'Ilha do 86', x: AE86.x, z: AE86.z, r: 12, point: [142, 38],
        text: 'O Toyota AE86 Sprinter Trueno, apelidado de Hachi-Roku ("oito-seis" em japonês), é o carro de Takumi Fujiwara em Initial D, mangá de Shuichi Shigeno (1995) que virou anime. ' +
          'Branco e preto como um panda, ele entregava tofu de madrugada descendo o monte Akina e virou lenda vencendo carros muito mais potentes nas curvas fechadas, no drift. ' +
          'O Shiba Inu toma conta do 86 por aqui. Modelo 3D low poly de IvOfficial (CC BY 3.0, Poly Pizza).',
        actions: [
          { label: '📯 Buzinar com o 86', run: () => { playHonk(); setTimeout(playHonk, 260); showCarSpeech('Bi-biii! 🚗💨', 1800); } },
          { label: '🐕 Fazer carinho no Shiba', run: () => { const d = critters.find((c) => c.isAe86Dog); if (d) { d.state = 'idle'; d.timer = 3; play(d, 'eat'); } showCarSpeech('Au au! 🐕', 1800); } }
        ]
      });
      loadGLB('./models/polypizza/toyota-ae86.glb').then((proto) => {
        const car = fitToSize(proto.clone(true), { length: 11 });
        car.position.set(AE86.x - 1, ISLAND_Y, AE86.z + 2); car.rotation.y = Math.PI * 0.08;
        scene.add(car);
        obstacles.push({ x: AE86.x - 1, z: AE86.z + 2, r: 6, box: { hx: 2.6, hz: 5.6 }, boxRot: car.rotation.y, h: 4 + ISLAND_TOP, isStatic: true, level: 'floor', name: 'TOYOTA AE86' });
      }).catch((e) => console.warn('[ae86]', e));
      // Painel informativo com arte própria (estrada de montanha à noite, curvas em "U" e o 86 panda)
      {
        const c = document.createElement('canvas'); c.width = 512; c.height = 320;
        const x = c.getContext('2d');
        const sky = x.createLinearGradient(0, 0, 0, 320); sky.addColorStop(0, '#0d1b3d'); sky.addColorStop(1, '#3c2a5e');
        x.fillStyle = sky; x.fillRect(0, 0, 512, 320);
        x.fillStyle = '#fff'; for (let i = 0; i < 60; i++) x.fillRect((i * 97) % 512, (i * 53) % 150, 2, 2);
        x.fillStyle = '#f4e9c1'; x.beginPath(); x.arc(420, 60, 26, 0, 7); x.fill();
        x.fillStyle = '#1b2a1f'; x.beginPath(); x.moveTo(0, 320); x.lineTo(0, 190); x.lineTo(130, 120); x.lineTo(250, 70); x.lineTo(360, 130); x.lineTo(512, 170); x.lineTo(512, 320); x.fill();
        x.strokeStyle = '#d9d2b6'; x.lineWidth = 7; x.lineJoin = 'round'; x.beginPath();
        x.moveTo(40, 300); x.lineTo(300, 270); x.quadraticCurveTo(350, 262, 300, 240); x.lineTo(150, 225); x.quadraticCurveTo(100, 215, 150, 200);
        x.lineTo(280, 180); x.quadraticCurveTo(330, 172, 290, 155); x.lineTo(230, 140); x.stroke();
        // 86 panda em perfil
        x.save(); x.translate(300, 285);
        x.fillStyle = '#111'; x.fillRect(-60, -20, 120, 16);
        x.fillStyle = '#f5f5f5'; x.beginPath(); x.moveTo(-62, -20); x.lineTo(-50, -34); x.lineTo(-12, -48); x.lineTo(30, -48); x.lineTo(52, -34); x.lineTo(64, -30); x.lineTo(64, -20); x.fill();
        x.fillStyle = '#6fb7e6'; x.fillRect(-8, -44, 34, 11);
        x.fillStyle = '#ffd35a'; x.fillRect(58, -28, 6, 5);
        x.fillStyle = '#222'; [-36, 40].forEach((wx) => { x.beginPath(); x.arc(wx, -4, 11, 0, 7); x.fill(); });
        x.restore();
        x.fillStyle = '#ffd166'; x.font = 'bold 40px Nunito, sans-serif'; x.fillText('HACHI-ROKU', 22, 52);
        x.fillStyle = '#fff'; x.font = 'bold 20px Nunito, sans-serif'; x.fillText('AE86 · monte Akina · drift', 24, 82);
        const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
        const board = new THREE.Group();
        const panel = new THREE.Mesh(new THREE.BoxGeometry(9, 5.6, 0.3), [0, 0, 0, 0, 0, 0].map((_, i) => i === 4 ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }) : new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.6 })));
        panel.position.y = 5.2; panel.castShadow = true;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x2b2e35 }));
        [-3.2, 3.2].forEach((lx) => { const l = leg.clone(); l.position.set(lx, 1.3, 0); board.add(l); });
        board.add(panel);
        board.position.set(AE86.x - 8.5, ISLAND_Y, AE86.z + 2); board.rotation.y = Math.PI / 2; // atrás do carro, de frente para a pista
        scene.add(board);
        obstacles.push({ x: AE86.x - 8.5, z: AE86.z + 2, r: 1.2, box: { hx: 4.5, hz: 0.4 }, boxRot: board.rotation.y, h: 8, isStatic: true, level: 'floor', name: 'PAINEL DO 86' });
      }
    }

    // ============================================================================
    // BICHOS, BRINQUEDOS GRANDES E HIDRANTE (Quaternius, Kenney Cube Pets, Poly Pizza)
    // Bichos passeiam perto de "casa", fogem do carrinho; pombos levantam voo. Hidrante enche o tanque.
    // ============================================================================
    const critters = [];
    // Modelos animados (com esqueleto) precisam de uma cópia própria: carrega o arquivo de novo (o navegador já tem em cache)
    function loadAnimated(url) {
      return new Promise((resolve, reject) => gltfLoader.load(url, (g) => {
        g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
        resolve(g);
      }, undefined, reject));
    }
    function addCritter(url, opts) {
      if (opts.scene !== SCENE) return;
      loadAnimated(url).then((g) => {
        const obj = fitToSize(g.scene, { height: opts.height });
        obj.position.set(opts.x, opts.y !== undefined ? opts.y : FLOOR_SURFACE_Y, opts.z);
        obj.rotation.y = Math.random() * Math.PI * 2;
        scene.add(obj);
        const mixer = new THREE.AnimationMixer(g.scene);
        const clip = (re) => g.animations.find((a) => re.test(a.name));
        const acts = {};
        Object.entries(opts.clips).forEach(([k, re]) => { const c = clip(re); if (c) acts[k] = mixer.clipAction(c); });
        const c = { obj, mixer, acts, cur: null, home: { x: opts.x, z: opts.z }, radius: opts.radius || 10,
          walk: opts.walk || 3, run: opts.run || 9, fleeR: opts.fleeR || 0, kind: opts.kind || 'walker',
          state: 'idle', timer: 1 + Math.random() * 3, tx: opts.x, tz: opts.z, y0: obj.position.y, vy: 0, canGo: opts.canGo || (() => true) };
        if (opts.tag) c[opts.tag] = true;
        play(c, 'idle');
        mixer.update(Math.random() * 2);
        critters.push(c);
      }).catch((e) => console.warn('[bicho]', url, e));
    }
    function play(c, name) {
      const a = c.acts[name] || c.acts.idle;
      if (!a || c.cur === a) return;
      a.reset().fadeIn(0.25).play();
      if (c.cur) c.cur.fadeOut(0.25);
      c.cur = a;
    }
    function updateCritters(dt) {
      if (!critters.length) return;
      const cx = vehicle.position.x, cz = vehicle.position.z;
      const carFast = Math.abs(carSpeed) > 0.05;
      for (let i = 0; i < critters.length; i++) {
        const c = critters[i], o = c.obj;
        c.mixer.update(dt);
        const dCar = Math.hypot(o.position.x - cx, o.position.z - cz);
        if (c.kind === 'bird') {
          if (c.state === 'fly') {
            c.vy = Math.min(c.vy + dt * 6, 9);
            o.position.y += c.vy * dt;
            o.position.x += Math.sin(o.rotation.y) * 10 * dt; o.position.z += Math.cos(o.rotation.y) * 10 * dt;
            c.timer -= dt;
            if (c.timer <= 0) { o.visible = false; c.state = 'away'; c.timer = 8 + Math.random() * 8; }
            continue;
          }
          if (c.state === 'away') {
            c.timer -= dt;
            if (c.timer <= 0 && Math.hypot(c.home.x - cx, c.home.z - cz) > 25) {
              o.position.set(c.home.x + (Math.random() - 0.5) * 6, c.y0, c.home.z + (Math.random() - 0.5) * 6);
              o.visible = true; c.state = 'idle'; c.timer = 2; play(c, 'idle');
            }
            continue;
          }
          if (dCar < c.fleeR && carFast) {
            c.state = 'fly'; c.vy = 2; c.timer = 3;
            o.rotation.y = Math.atan2(o.position.x - cx, o.position.z - cz);
            play(c, 'fly');
            if (!sfx('flap', { vol: 0.35, rate: 1.4 })) playTone(900, 0, 0.05, 'triangle', 0.02);
            continue;
          }
        } else if (c.fleeR && dCar < c.fleeR) {
          // Foge na direção oposta ao carrinho
          const ax = o.position.x - cx, az = o.position.z - cz, d = Math.hypot(ax, az) || 1;
          c.state = 'flee'; c.tx = o.position.x + (ax / d) * 18; c.tz = o.position.z + (az / d) * 18; c.timer = 1.2;
        }
        if (c.state === 'idle') {
          play(c, c.acts.eat && Math.random() < 0.002 ? 'eat' : (c.cur === c.acts.eat ? 'eat' : 'idle'));
          c.timer -= dt;
          if (c.timer <= 0) {
            for (let t = 0; t < 8; t++) {
              const a = Math.random() * Math.PI * 2, r = c.radius * Math.sqrt(Math.random());
              const tx = c.home.x + Math.cos(a) * r, tz = c.home.z + Math.sin(a) * r;
              if (c.canGo(tx, tz)) { c.tx = tx; c.tz = tz; c.state = 'walk'; break; }
            }
            c.timer = 2 + Math.random() * 4;
          }
        } else {
          const run = c.state === 'flee';
          const dx = c.tx - o.position.x, dz = c.tz - o.position.z, d = Math.hypot(dx, dz);
          if (d < 0.6 || (run && (c.timer -= dt) <= 0 && dCar > c.fleeR)) { c.state = 'idle'; c.timer = 1.5 + Math.random() * 3; play(c, 'idle'); continue; }
          const sp = (run ? c.run : c.walk) * dt;
          const nx = o.position.x + (dx / d) * Math.min(sp, d), nz = o.position.z + (dz / d) * Math.min(sp, d);
          if (!c.canGo(nx, nz)) { c.state = 'idle'; c.timer = 0.5; play(c, 'idle'); continue; }
          o.position.x = nx; o.position.z = nz;
          const want = Math.atan2(dx, dz);
          let dr = want - o.rotation.y; dr = Math.atan2(Math.sin(dr), Math.cos(dr));
          o.rotation.y += dr * Math.min(1, dt * 8);
          play(c, run ? 'run' : 'walk');
        }
      }
    }
    {
      const inYard = (x, z) => x > 126 && x < 336 && z > -76 && z < 96 && mountainH(x, z) < 0.05 && Math.hypot(x - POND.x, z - POND.z) > POND.r + 2 &&
        Math.hypot(x - 185, z - 64) > 17 && Math.hypot(x - 152, z - 70) > 16 && Math.hypot(x - 133, z - 47) > 14 &&
        (!IS_QUINTAL || rallyNearest(x, z).dist > RALLY_SIDE + 1.5); // bichos não passeiam na pista nem nas ilhas
      const QQ = 'quintal';
      // Shiba Inu do quintal: passeia perto da casa e corre quando o carrinho chega perto
      const onAe86Island = (x, z) => {
        const dx = x - 132, dz = z - 49, c = Math.cos(-Math.PI * 0.08), s = Math.sin(-Math.PI * 0.08);
        const lx = dx * c - dz * s, lz = dx * s + dz * c; // coordenadas no eixo do carro
        return Math.hypot(x - 133, z - 47) < 9.5 && !(Math.abs(lx) < 3.6 && Math.abs(lz) < 6.6) && Math.abs(x - 124.5) > 1.2;
      };
      addCritter('./models/quaternius/animals/shiba-inu.glb', { scene: QQ, x: 126, z: 41, y: ISLAND_Y, height: 4.5, radius: 9, walk: 3, run: 7, fleeR: 6,
        clips: { idle: /^Idle$/, walk: /^Walk$/, run: /^Gallop$/, eat: /^Eating$/ }, canGo: onAe86Island, tag: 'isAe86Dog' });
      // Pombos no gramado: levantam voo quando o carrinho passa rápido
      [[170, 84], [176, 86], [300, -60], [306, -57]].forEach(([x, z]) => addCritter('./models/quaternius/animals/pigeon.glb', {
        scene: QQ, kind: 'bird', x, z, height: 1.8, radius: 4, walk: 1.2, fleeR: 12,
        clips: { idle: /\|Idle$/, walk: /\|Walk$/, fly: /\|Jump$/ }, canGo: inYard }));
      // Pintinhos (Kenney Cube Pets) perto do balanço
      [[136, -48], [139, -45], [134, -43]].forEach(([x, z]) => addCritter('./models/kenney/cube-pets/animal-chick.glb', {
        scene: QQ, x, z, height: 1.6, radius: 9, walk: 2, run: 7, fleeR: 7,
        clips: { idle: /^idle$/, walk: /^walk$/, run: /^run$/, eat: /^eat$/ }, canGo: inYard }));
      // Gato na cama do Ravi (quarto)
      addCritter('./models/kenney/cube-pets/animal-cat.glb', { scene: 'quarto', x: 120, z: 10, y: FLOOR_SURFACE_Y + 11, height: 3.6, radius: 0.1,
        clips: { idle: /^idle$/, walk: /^idle$/, eat: /^eat$/ } });
      // Balanço do quintal ("Swing set", Poly by Google, CC-BY)
      placeGLB('./models/polypizza/swing-set.glb', { scene: QQ, x: 140, z: -62, rotY: 0.3, height: 16,
        collider: { r: 9, box: { hx: 9, hz: 4 }, boxRot: 0.3, h: 16 }, name: 'BALANÇO' });
      // Brinquedos grandes no quarto: caminhão de bombeiro (Ivan Klus, CC-BY) e viatura de polícia (Quaternius, CC0)
      placeGLB('./models/polypizza/fire-truck.glb', { scene: 'quarto', x: 160, z: -22, rotY: 0.5, length: 16,
        collider: { r: 8, box: { hx: 3.4, hz: 8 }, boxRot: 0.5, h: 8 }, name: 'CAMINHÃO DE BOMBEIRO' });
      placeGLB('./models/quaternius/police-car.glb', { scene: 'quarto', x: 198, z: 44, rotY: -0.7, length: 11,
        collider: { r: 6, box: { hx: 2.8, hz: 5.5 }, boxRot: -0.7, h: 5 }, name: 'VIATURA' });
    }
    // Hidrante ao lado do Posto do Bombeiro: encosta nele e o tanque d'água enche
    const HYDRANT = { x: -110, z: 67, r: 6.5 };
    let hydrantObj = null;
    placeGLB('./models/quaternius/fire-hydrant.glb', { scene: 'quarto', x: HYDRANT.x, z: HYDRANT.z, rotY: 0.6, height: 5.5,
      collider: { r: 1.4, h: 5.5 }, name: 'HIDRANTE', onLoad: (m) => { hydrantObj = m; } });

    // Sons ambientes em loop: grilos à noite e pneu no cascalho do quintal
    const ambientLoops = { started: false, list: [] };
    function updateAmbientAudio() {
      if (!audioCtx) return;
      if (!ambientLoops.started) {
        ambientLoops.started = true;
        [['crickets', './assets/sfx/loops/crickets-night.wav'], ['gravel', './assets/sfx/loops/tires-gravel.mp3']].forEach(([name, url]) => {
          fetch(url).then((r) => r.arrayBuffer()).then((b) => new Promise((res, rej) => audioCtx.decodeAudioData(b, res, rej))).then((buf) => {
            const src = audioCtx.createBufferSource(); src.buffer = buf; src.loop = true;
            const g = audioCtx.createGain(); g.gain.value = 0;
            src.connect(g).connect(audioOut(audioCtx)); src.start();
            ambientLoops.list.push({ name, src, g });
          }).catch(() => { /* sem o som ambiente */ });
        });
      }
      const t = audioCtx.currentTime;
      for (const L of ambientLoops.list) {
        let v = 0, rate = 1;
        if (L.name === 'crickets') v = (dayCycle.night || 0) * (IS_QUINTAL ? 0.32 : 0.08);
        else if (L.name === 'gravel') {
          const k = Math.min(1, Math.abs(carSpeed) / baseMaxSpeed);
          v = IS_QUINTAL && !carAirborne && !isFallingOff && vehicle.position.y < -15 ? k * 0.4 : 0;
          rate = 0.75 + 0.45 * k;
        }
        L.g.gain.setTargetAtTime(v, t, 0.15);
        L.src.playbackRate.setTargetAtTime(rate, t, 0.2);
      }
    }

    // Retira do quintal tudo o que pertence ao quarto (o motor é o mesmo; aqui ele só não desenha nem simula)
    function cullOtherScene() {
      if (!IS_QUINTAL) return;
      const keep = new Set([vehicle, mainLight, mainLight.target, ambientLight]);
      roomWallMeshes.forEach((m) => { if (m.parent) m.parent.remove(m); });
      const box = new THREE.Box3();
      [scene, bedroomWorld].forEach((parent) => {
        [...parent.children].forEach((o) => {
          if (o.userData.quarto) { parent.remove(o); return; } // marcado como só do quarto
          if (keep.has(o) || o.userData.quintal || o === deskWorld || o === bedroomWorld || o.isInstancedMesh || o.frustumCulled === false) return;
          if (o.isLight) { if (o.position.x < QUINTAL_MIN_X) parent.remove(o); return; }
          box.setFromObject(o);
          if (box.isEmpty()) return;
          if ((box.min.x + box.max.x) / 2 < QUINTAL_MIN_X) parent.remove(o);
        });
      });
      if (deskWorld.parent) deskWorld.parent.remove(deskWorld);
      const isHere = (o) => o.x >= QUINTAL_MIN_X - 2;
      for (let i = obstacles.length - 1; i >= 0; i--) if (!isHere(obstacles[i])) obstacles.splice(i, 1);
      for (let i = dynamicObstacles.length - 1; i >= 0; i--) if (!isHere(dynamicObstacles[i])) dynamicObstacles.splice(i, 1);
      for (let i = grabbableItems.length - 1; i >= 0; i--) if (!(grabbableItems[i].group && grabbableItems[i].group.position.x >= QUINTAL_MIN_X)) grabbableItems.splice(i, 1);
      for (let i = islands.length - 1; i >= 0; i--) if (islands[i].x < QUINTAL_MIN_X) islands.splice(i, 1);
      staticGridCount = -1;
    }

    // Testes locais: avança a física sem depender do requestAnimationFrame (janela sem foco congela o rAF)
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      window.__step = (n = 1) => { for (let i = 0; i < n; i++) physicsStep(performance.now() / 1000 + i / 60); };
    }
    function physicsStep(time) {
      // Posição física anterior de cada objeto móvel (para interpolar o desenho entre passos)
      for (let i = 0; i < dynamicObstacles.length; i++) {
        const o = dynamicObstacles[i];
        o._px = o.x; o._pz = o.z;
      }
      if (!isModalOpen) stepVehicle(time);
      updateRace();
      stepDynamicObjects();
      checkBallOnDesk();
      stepWaterDrops(time);
      stepSparks();
    }

    window.addEventListener('resize', () => {
      sizes.width = window.innerWidth;
      sizes.height = window.innerHeight;
      camera.aspect = sizes.width / sizes.height;
      camera.updateProjectionMatrix();
      renderer.setSize(sizes.width, sizes.height);
      renderer.setPixelRatio(highQuality ? Math.min(window.devicePixelRatio, 2) : 1);
    });

    const clock = new THREE.Clock();
    let prevTime = 0;
    const lastLookTarget = new THREE.Vector3();
    let lastCamLevel = 'desk';
    let lastScreenTick = 0;
    let closeCamAngle = -0.55;
    const camFollowTarget = new THREE.Vector3(11.5, 1.2, 11.5);
    const closeLookAhead = new THREE.Vector3();
    const renderInterp = {
      active: false, prevPos: new THREE.Vector3(), physPos: new THREE.Vector3(), shownPos: new THREE.Vector3(),
      prevYaw: 0, physYaw: 0
    };

    function animate() {
      requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();
      const dt = Math.min(0.1, elapsedTime - prevTime);
      prevTime = elapsedTime;

      pollGamepad();
      // Tela do Antigravity animada (monitor + notebook)
      if (monitorState === 'normal' && !monitorProfileMode && elapsedTime - lastScreenTick > 0.12) {
        lastScreenTick = elapsedTime;
        updateMonitorScreen();
      }

      // Peixes e bolhas do aquário
      fishes.forEach((f) => {
        const t = elapsedTime * f.speed + f.phase;
        const fx = Math.cos(t) * f.radiusX;
        const fz = Math.sin(t * 1.3) * f.radiusZ;
        const nextFx = Math.cos(t + 0.05) * f.radiusX;
        const nextFz = Math.sin((t + 0.05) * 1.3) * f.radiusZ;
        f.group.position.set(fx, f.y + Math.sin(t * 2) * 0.25, fz);
        f.group.rotation.y = Math.atan2(-(nextFz - fz), nextFx - fx);
        if (f.tailFin) f.tailFin.rotation.y = Math.sin(elapsedTime * 14 + f.phase) * 0.38;
      });
      aquariumBubbles.forEach((b) => {
        const src = b.src;
        const rise = clamp((b.mesh.position.y - src.y) / (9.0 - src.y), 0, 1);
        // Sobe acelerando, oscila em espiral e cresce (menos pressão perto da superfície)
        b.mesh.position.y += b.speed * (0.8 + rise * 0.6) * dt;
        b.mesh.position.x = src.x + Math.sin(elapsedTime * 4 + b.wobble) * (0.15 + rise * 0.3);
        b.mesh.position.z = src.z + Math.cos(elapsedTime * 3.3 + b.wobble) * (0.12 + rise * 0.25);
        b.mesh.scale.setScalar(b.size * (0.7 + rise * 0.7));
        if (b.mesh.position.y > 9.1) {
          b.mesh.position.y = src.y;
          b.wobble = Math.random() * Math.PI * 2;
        }
      });
      turboBatteries.forEach((tb, idx) => {
        const s = 1.0 + Math.sin(elapsedTime * 5 + idx) * 0.1;
        tb.ring.scale.set(s, s, 1);
      });

      // Copo derrubado: tomba e a poça se espalha
      if (cupSpilled) {
        updateCupFall(dt);
        // A poça só começa a crescer quando a boca do copo chega perto da mesa, e se espalha alongada no sentido do tombo
        if (puddleScale < 1.0 && cupFall.theta > 1.0) {
          puddleScale = Math.min(1.0, puddleScale + dt * 1.3);
          const ease = 1 - Math.pow(1 - puddleScale, 2);
          // Geometria da poça fica no plano XZ: x = sentido do tombo (mais comprida), z = largura
          puddleMesh.scale.set(ease * 1.25, 1, ease * 0.85);
        }
      }

      // Crescimento gradual das plantas regadas
      growablePlants.forEach((p) => {
        if (p.isWatered && p.level < 2) {
          p.growthElapsed += dt;
          const progress = Math.min(1.0, p.growthElapsed / PLANT_GROWTH_DURATION);
          p.targetScale = 1.0 + progress * 0.85;
          if (p.foliageGroup) p.foliageGroup.scale.set(p.targetScale, p.targetScale, p.targetScale);
          else if (p.foliageMeshes) p.foliageMeshes.forEach(m => m.scale.setScalar(1 + progress * 0.35));
          if (progress >= 1.0) {
            p.level = 2;
            if (p.flowersGroup) p.flowersGroup.visible = true;
            logInteractionEvent(`🌸 ${p.name} floresceu no nível 2!`);
            setStatusBanner(`🌸 ${p.name} chegou ao nível 2!`, '#7ee787');
          }
        }
      });

      // Incêndio e autodestruição do monitor ultrawide
      const burning = monitorState === 'burning';
      htmlEl.classList.toggle('is-fire', burning);
      if (burning && !isModalOpen) {
        fireTimer -= dt;
        fireTimerEl.textContent = Math.max(0, fireTimer).toFixed(1);
        fireTimeBarEl.style.transform = `scaleX(${clamp(fireTimer / 15, 0, 1)})`;
        fireLight.intensity = 2.2 + Math.sin(elapsedTime * 18) * 0.9;
        fireCones.forEach((c, idx) => { c.scale.y = 0.8 + Math.sin(elapsedTime * 14 + idx) * 0.35; });
        updateMonitorScreen();

        if (fireTimer <= 0) {
          monitorState = 'exploded';
          monitorFireGroup.visible = false;
          fireLight.intensity = 0;
          monitorHeadGroup.rotation.z = -0.14;
          monitorHeadGroup.rotation.x = 0.12;
          curvedBack.material.color.setHex(0x090a0c);
          updateMonitorScreen();
          setStatusBanner('💥 BOOM! O monitor explodiu! Reinicie pelo menu para consertar.', '#ff5252');
          logInteractionEvent('💥 O monitor 1 explodiu após a contagem de autodestruição!');
          notify({ type: 'danger', title: 'BOOM!', description: 'O monitor explodiu. Menu › Opções › Reiniciar', duration: 5500 });
          for (let i = 0; i < 16; i++) {
            const shard = new THREE.Mesh(
              new THREE.BoxGeometry(0.5, 0.2, 0.5),
              new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0x111111 : 0x35e0ff })
            );
            shard.position.set(6.5 + (Math.random() - 0.5) * 14, 0.2, -5 + Math.random() * 8);
            shard.rotation.set(Math.random(), Math.random(), Math.random());
            deskWorld.add(shard);
            controllerDebrisList.push(shard);
          }
        }
      }

      // Física em passo fixo (60 Hz): mesma velocidade em monitores de 60, 120 ou 144 Hz
      // Restaura o estado físico do carrinho (o quadro anterior mostrou uma posição interpolada).
      // Se algo moveu o carrinho fora da física (teleporte, reinício), aceita a nova posição.
      if (renderInterp.active) {
        if (vehicle.position.distanceToSquared(renderInterp.shownPos) < 1e-10) {
          vehicle.position.copy(renderInterp.physPos);
          vehicle.rotation.y = renderInterp.physYaw;
        } else {
          renderInterp.prevPos.copy(vehicle.position);
          renderInterp.prevYaw = vehicle.rotation.y;
        }
      }
      physAccumulator += dt;
      let steps = 0;
      while (physAccumulator >= PHYS_STEP && steps < 8) {
        renderInterp.prevPos.copy(vehicle.position);
        renderInterp.prevYaw = vehicle.rotation.y;
        physicsStep(elapsedTime);
        physAccumulator -= PHYS_STEP;
        steps++;
      }
      if (steps >= 8) physAccumulator = 0;
      // Interpolação visual entre os dois últimos passos de 60 Hz (sem tremedeira em telas 120/144 Hz)
      renderInterp.physPos.copy(vehicle.position);
      renderInterp.physYaw = vehicle.rotation.y;
      if (!isFallingOff) {
        const alpha = clamp(physAccumulator / PHYS_STEP, 0, 1);
        vehicle.position.lerpVectors(renderInterp.prevPos, renderInterp.physPos, alpha);
        let dYaw = renderInterp.physYaw - renderInterp.prevYaw;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        vehicle.rotation.y = renderInterp.prevYaw + dYaw * alpha;
      }
      renderInterp.shownPos.copy(vehicle.position);
      renderInterp.active = true;
      // Objetos móveis: o desenho SEMPRE acompanha a física (antes só atualizava no instante da batida,
      // então a bola/caixa "congelava" na tela enquanto deslizava) — com interpolação suave
      {
        const alphaObj = clamp(physAccumulator / PHYS_STEP, 0, 1);
        for (let i = 0; i < dynamicObstacles.length; i++) {
          const o = dynamicObstacles[i];
          if (!o.group || (heldItem && heldItem.obs === o)) continue;
          const px = o._px !== undefined ? o._px : o.x, pz = o._pz !== undefined ? o._pz : o.z;
          // Teleporte (reset/respawn): não interpola
          if (Math.abs(o.x - px) > 6 || Math.abs(o.z - pz) > 6) { o.group.position.x = o.x; o.group.position.z = o.z; continue; }
          o.group.position.x = px + (o.x - px) * alphaObj;
          o.group.position.z = pz + (o.z - pz) * alphaObj;
        }
      }

      updateFloatingProps(elapsedTime);
      updateShadowFollow();
      updateDayCycle(dt);
      updateCritters(Math.min(dt, 0.1));
      updateAmbientAudio();
      updateWorldEffects(elapsedTime, dt);
      updateGateGlow(elapsedTime);
      updateSiren(elapsedTime);
      updatePaintUniforms(elapsedTime);
      updatePointerInteraction(dt);
      updateMagicTrail(dt, elapsedTime);

      // Preset automático: em cima da mesa = Isométrica; ao descer para o quarto = Atrás do carrinho
      // (só alterna entre esses dois; Quarto e Mesa completa continuam fixos se escolhidos no menu)
      const camLevelNow = vehicle.position.y > (lastCamLevel === 'desk' ? -8 : -4) ? 'desk' : 'floor';
      if (camLevelNow !== lastCamLevel) {
        lastCamLevel = camLevelNow;
        if (camMode === 'iso' || camMode === 'close') setCameraMode(camLevelNow === 'desk' ? 'iso' : 'close');
      }

      // Órbita manual pelo analógico direito (volta ao centro quando solto)
      // Eixos invertidos (pedido): direita gira a câmera para a direita, para cima sobe a câmera
      if (Math.abs(padInput.camX) > 0) camOrbitYaw -= padInput.camX * dt * 2.4;
      else camOrbitYaw *= Math.pow(0.2, dt);
      if (Math.abs(padInput.camY) > 0) camOrbitPitch = clamp(camOrbitPitch - padInput.camY * dt * 1.4, -0.45, 0.7);
      else camOrbitPitch *= Math.pow(0.2, dt);

      // Câmera dinâmica — 4 modos: isométrica (inicial), atrás do carrinho, quarto e mesa completa
      let camOffset, lookTarget;
      const vp = vehicle.position;
      if (camMode === 'close' || camMode === 'fps') {
        // Ângulo suavizado (curvas não sacodem a câmera)
        let dA = carAngle - closeCamAngle;
        dA = Math.atan2(Math.sin(dA), Math.cos(dA));
        closeCamAngle += dA * (1 - Math.exp(-dt * (camMode === 'fps' ? 9 : 5)));
        const viewAngle = closeCamAngle + Math.PI;
        // Atrás do carrinho: carro inteiro à frente da câmera. Primeira pessoa: colada no teto, canhão à frente.
        const distCam = (camMode === 'fps' ? 3.6 : 9.4) * zoomFactor;
        const heightCam = (camMode === 'fps' ? 3.3 : 4.9) * zoomFactor;
        camOffset = new THREE.Vector3(Math.sin(viewAngle) * distCam, heightCam, Math.cos(viewAngle) * distCam);
        // Base da câmera = carrinho; ela olha à frente dele
        lookTarget = new THREE.Vector3(vp.x, vp.y + 1.2, vp.z);
        const ahead = camMode === 'fps' ? 10 : 3.2;
        closeLookAhead.set(Math.sin(closeCamAngle) * ahead, camMode === 'fps' ? 1.4 : 0.2, Math.cos(closeCamAngle) * ahead);
      } else if (camMode === 'room') {
        camOffset = new THREE.Vector3(88 * zoomFactor, 74 * zoomFactor, 118 * zoomFactor);
        lookTarget = new THREE.Vector3(0, -18, 15);
      } else if (camMode === 'wide') {
        camOffset = new THREE.Vector3(0, 68 * zoomFactor, 95 * zoomFactor);
        lookTarget = new THREE.Vector3(0, 2, 0);
      } else {
        // Isométrica: segue o carrinho na mesa, na rampa e no quarto
        camOffset = new THREE.Vector3(18 * zoomFactor, 26 * zoomFactor, 32 * zoomFactor);
        lookTarget = new THREE.Vector3(vp.x, vp.y + 1.0, vp.z);
      }
      if (camMode === 'close' || camMode === 'fps' || camMode === 'iso') {
        camOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), camOrbitYaw);
        camOffset.y *= 1 + camOrbitPitch;
      }
      lastLookTarget.copy(lookTarget);

      if (isFreeCameraActive) {
        freeOrbitControls.update();
      } else if (rocketLaunch && spaceRocket) {
        // Câmera exclusiva da decolagem: rente ao gramado da ilha, olhando de baixo para cima
        const rp = spaceRocket.position;
        if (!rocketLaunch.camPos) {
          let ax = vp.x - rp.x, az = vp.z - rp.z;
          const al = Math.hypot(ax, az) || 1;
          ax /= al; az /= al;
          rocketLaunch.camPos = new THREE.Vector3(rp.x + ax * 9 - az * 4, ISLAND_Y + 1.1, rp.z + az * 9 + ax * 4);
          rocketLaunch.look = new THREE.Vector3(rp.x, rp.y + 6, rp.z);
          rocketLaunch.fov = camera.fov;
        }
        const t = rocketLaunch.t;
        // Leve aproximação no começo, tremor na ignição e no pouso
        const shake = (t < 1.4 || (t > 7.2 && t < 7.8)) ? 0.12 : (t < 4.6 ? 0.05 : 0);
        camera.position.lerp(rocketLaunch.camPos, 1 - Math.exp(-dt * 6));
        camera.position.x += (Math.random() - 0.5) * shake;
        camera.position.y += (Math.random() - 0.5) * shake;
        rocketLaunch.look.lerp(new THREE.Vector3(rp.x, rp.y + 6, rp.z), 1 - Math.exp(-dt * 4));
        camera.lookAt(rocketLaunch.look);
        // Placa da ilha some durante o voo (não tapa o foguete)
        islands.forEach((isl) => { if (isl.label) isl.label.visible = isl.id !== 'space'; });
        // Aberta na ignição, fecha o zoom quando o foguete está lá no alto
        const altitude = clamp((rp.y - rocketLaunch.baseY) / 75, 0, 1);
        const fovTarget = 62 - altitude * 26;
        if (Math.abs(camera.fov - fovTarget) > 0.05) { camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
        camFollowTarget.copy(lookTarget);
      } else if (familyView) {
        // Aproximação lenta e suave até o quadro; acelerar ou dar ré (ou 12 s) volta ao jogo
        familyView.t += dt;
        const ease = 1 - Math.exp(-familyView.t * 0.6);
        const goal = new THREE.Vector3(-31, 9.6, -28 - ease * 7); // levemente à direita: o pórtico da pista fica fora do quadro
        camera.position.lerp(goal, 1 - Math.exp(-dt * 2.5));
        familyView.look.lerp(FAMILY_FRAME_POS, 1 - Math.exp(-dt * 3));
        camera.lookAt(familyView.look);
        const wantsToDrive = keys.forward || keys.backward || padInput.throttle > 0.2 || padInput.reverse > 0.2;
        if (familyView.t > 12 || (familyView.t > 1 && wantsToDrive)) familyView = null;
        camFollowTarget.copy(lookTarget);
      } else {
        if (rocketCamFovRestore !== null) {
          camera.fov += (rocketCamFovRestore - camera.fov) * (1 - Math.exp(-dt * 4));
          if (Math.abs(camera.fov - rocketCamFovRestore) < 0.05) { camera.fov = rocketCamFovRestore; rocketCamFovRestore = null; }
          camera.updateProjectionMatrix();
        }
        // Suavização independente da taxa de quadros (equivale a 0.09 por quadro a 60 Hz)
        // Alvo suavizado uma única vez e câmera presa a ele: posição e direção andam juntas
        const followRate = (camMode === 'close' || camMode === 'fps') ? 9 : 5.6;
        const k = 1 - Math.exp(-dt * followRate);
        if (camFollowTarget.distanceToSquared(lookTarget) > 900) camFollowTarget.copy(lookTarget); // teleporte
        camFollowTarget.lerp(lookTarget, k);
        const desired = camFollowTarget.clone().add(camOffset);
        if (camMode === 'close' || camMode === 'fps') {
          // Nunca abaixo do terreno atrás do carrinho (ex.: descendo a rampa, o trecho de trás é mais alto)
          const behindGround = sampleGround(desired.x, desired.z, vp.y + 6);
          desired.y = Math.max(desired.y, behindGround.y + (camMode === 'fps' ? 2.2 : 3.2));
          camera.position.copy(desired);
          camera.lookAt(camFollowTarget.clone().add(closeLookAhead));
        } else {
          camera.position.lerp(desired, 1 - Math.pow(1 - 0.09, dt * 60));
          camera.lookAt(camFollowTarget);
        }
      }

      // Tremor de câmera da explosão de sobrecarga
      if (explosionShake > 0 && !isFreeCameraActive) {
        camera.position.x += (Math.random() - 0.5) * explosionShake;
        camera.position.y += (Math.random() - 0.5) * explosionShake;
        camera.position.z += (Math.random() - 0.5) * explosionShake;
      }

      // Oclusão: objetos grandes ficam translúcidos quando escondem o carrinho
      const camPos = camera.position;
      const carCenter = vehicle.position.clone().add(new THREE.Vector3(0, 1.1, 0));
      const rayDir = carCenter.clone().sub(camPos);
      const rayDist = rayDir.length();
      rayDir.normalize();
      occlusionRaycaster.set(camPos, rayDir);
      occlusionRaycaster.near = 1.0;
      occlusionRaycaster.far = Math.max(1.0, rayDist - 1.2);
      const hits = occlusionRaycaster.intersectObjects(occluderMeshes, false); // lista fixa de malhas, sem varrer filhos
      const currentOccluded = new Set();
      // Objetos fixos entre a câmera e o carrinho ficam 90% transparentes (opacidade 0.1)
      const OCCLUDED_OPACITY = 0.1;
      const matsOf = (m) => (Array.isArray(m.material) ? m.material : [m.material]);
      hits.forEach((h) => {
        const m = h.object;
        if (m.material && !m.isCar) {
          currentOccluded.add(m);
          if (m._origOpacity === undefined) {
            const first = matsOf(m)[0];
            m._origOpacity = first.opacity !== undefined ? first.opacity : 1.0;
            m._origTransparent = !!first.transparent;
            m._origDepthWrite = first.depthWrite !== false;
          }
          matsOf(m).forEach((mat) => {
            mat.transparent = true;
            mat.depthWrite = false; // não esconde o carrinho atrás dela
            mat.opacity = THREE.MathUtils.lerp(mat.opacity, Math.min(OCCLUDED_OPACITY, m._origOpacity), 0.25);
          });
        }
      });
      occludedMeshesSet.forEach((m) => {
        if (!currentOccluded.has(m) && m.material) {
          const target = m._origOpacity || 1.0;
          let done = true;
          matsOf(m).forEach((mat) => {
            mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.18);
            if (Math.abs(mat.opacity - target) >= 0.05) done = false;
          });
          if (done) {
            matsOf(m).forEach((mat) => {
              mat.opacity = target;
              mat.transparent = m._origTransparent || false;
              mat.depthWrite = m._origDepthWrite !== false;
            });
            occludedMeshesSet.delete(m);
          }
        }
      });
      currentOccluded.forEach(m => occludedMeshesSet.add(m));

      // Tampo da mesa translúcido quando o carrinho está embaixo dela
      const isCarUnderDesk = vehicle.position.y < -15 && Math.abs(vehicle.position.x) < DESK_HALF_W && Math.abs(vehicle.position.z) < DESK_HALF_D;
      if (isCarUnderDesk) {
        deskMat.transparent = true;
        deskMat.opacity = THREE.MathUtils.lerp(deskMat.opacity, 0.1, 0.25);
      } else if (!currentOccluded.has(deskTop)) {
        deskMat.opacity = THREE.MathUtils.lerp(deskMat.opacity, 1.0, 0.18);
        if (deskMat.opacity > 0.95) { deskMat.opacity = 1.0; deskMat.transparent = false; }
      }

      updateSpeechBubblePosition();
      updateInteractives(elapsedTime);
      updateNotificationBars(performance.now());
      updateMapPlayer();
      renderer.render(scene, camera);
    }

    // ============================================================================
    // CÂMERA LIVRE (ORBITCONTROLS, ESPAÇO NO MODO DEV) E CICLO DE CÂMERAS (V)
    // ============================================================================
    const freeOrbitControls = new THREE.OrbitControls(camera, renderer.domElement);
    freeOrbitControls.enabled = false;
    freeOrbitControls.enableDamping = true;
    freeOrbitControls.dampingFactor = 0.08;
    let isFreeCameraActive = false;

    function enableFreeCamera(on) {
      if (on === isFreeCameraActive) return;
      isFreeCameraActive = on;
      if (on) {
        // Orbita em torno do que a câmera já olhava (antes pulava para a origem)
        freeOrbitControls.target.copy(lastLookTarget);
        freeOrbitControls.update();
      }
      freeOrbitControls.enabled = on;
      transformControl.enabled = devModeActive && !on;
      document.body.style.cursor = on ? 'grab' : '';
    }

    const camModesList = ['iso', 'close', 'fps', 'room', 'wide'];
    function cycleCameraMode() {
      const nextIdx = (camModesList.indexOf(camMode) + 1) % camModesList.length;
      setCameraMode(camModesList[nextIdx]);
      setStatusBanner('📷 Câmera: ' + CAMERA_PRESETS[camMode].label, '#35e0ff');
    }

    // ============================================================================
    // MODO DE EDIÇÃO DO DESENVOLVEDOR (TRANSFORM CONTROLS)
    // ============================================================================
    let devModeActive = false;
    let devSelectedObject = null;
    const devRaycaster = new THREE.Raycaster();
    const devMouse = new THREE.Vector2();

    const transformControl = new THREE.TransformControls(camera, renderer.domElement);
    transformControl.size = 0.85;
    transformControl.enabled = false;
    scene.add(transformControl);

    transformControl.addEventListener('dragging-changed', (event) => {
      // Bloqueia a órbita enquanto arrasta o gizmo (antes referenciava uma variável inexistente)
      if (isFreeCameraActive) freeOrbitControls.enabled = !event.value;
    });

    transformControl.addEventListener('objectChange', () => {
      const obj = devSelectedObject;
      if (!obj) return;
      const obs = (obj.userData && obj.userData.obs) || obstacles.find(o => o.group === obj);
      if (obs) {
        obs.x = obj.position.x;
        obs.z = obj.position.z;
        obs.level = levelOfY(obj.position.y);
        obs.restOffset = obj.position.y - surfaceBaseY(obj.position.y);
        obs.vx = 0; obs.vz = 0;
      }
    });

    const devBarEl = document.getElementById('dev-mode-bar');
    const devSelectedNameEl = document.getElementById('dev-selected-name');
    const btnToggleDevEl = document.getElementById('btn-toggle-dev');
    const devBtnTranslateEl = document.getElementById('dev-btn-translate');
    const devBtnRotateEl = document.getElementById('dev-btn-rotate');
    const devBtnCloseEl = document.getElementById('dev-btn-close');
    const devBtnSaveEl = document.getElementById('dev-btn-save');
    const devBtnAddModelEl = document.getElementById('dev-btn-add-model');
    const devSelectModelEl = document.getElementById('dev-add-model-select');
    const devBtnDeleteEl = document.getElementById('dev-btn-delete');

    // Lista de inserção gerada a partir da biblioteca completa de modelos
    devSelectModelEl.innerHTML = '<option value="">+ Modelo 3D…</option>' +
      Object.keys(MODEL_LIBRARY)
        .filter(k => !['lightning_bolt', 'location_marker', 'arrow_01', 'fire_alarm_bell', 'light_switch_01', 'guitar_wall_hanger_02'].includes(k))
        .sort((a, b) => MODEL_LIBRARY[a].name.localeCompare(MODEL_LIBRARY[b].name, 'pt-BR'))
        .map(k => `<option value="${k}">${MODEL_LIBRARY[k].name}</option>`).join('');

    function setTransformMode(mode) {
      transformControl.setMode(mode);
      devBtnTranslateEl.classList.toggle('is-active', mode === 'translate');
      devBtnRotateEl.classList.toggle('is-active', mode === 'rotate');
    }
    devBtnTranslateEl.addEventListener('click', () => setTransformMode('translate'));
    devBtnRotateEl.addEventListener('click', () => setTransformMode('rotate'));

    function toggleDevMode(forceState) {
      devModeActive = forceState !== undefined ? forceState : !devModeActive;
      devBarEl.classList.toggle('is-visible', devModeActive);
      htmlEl.classList.toggle('is-dev', devModeActive);
      transformControl.enabled = devModeActive;
      btnToggleDevEl.classList.toggle('is-active', devModeActive);
      if (!devModeActive) {
        transformControl.detach();
        devSelectedObject = null;
        devSelectedNameEl.textContent = '(clique em um objeto)';
        enableFreeCamera(false);
      } else if (menuOpen) {
        closeMenu();
      }
      logInteractionEvent(devModeActive ? '🛠️ Modo dev ATIVADO' : '🛠️ Modo dev DESATIVADO');
      setStatusBanner(devModeActive ? '🛠️ MODO EDIÇÃO: clique em um objeto para mover/girar.' : '🏎️ Modo de jogo normal.');
    }
    btnToggleDevEl.addEventListener('click', () => toggleDevMode());
    devBtnCloseEl.addEventListener('click', () => toggleDevMode(false));

    function deleteSelectedDevObject() {
      if (!devSelectedObject) {
        notify({ type: 'danger', title: 'Nada selecionado', description: 'Clique em um objeto primeiro', duration: 2400 });
        return;
      }
      const targetObj = devSelectedObject;
      const objName = targetObj.name || 'Objeto';
      transformControl.detach();
      devSelectedObject = null;
      devSelectedNameEl.textContent = '(clique em um objeto)';
      if (heldItem && heldItem.group === targetObj) releaseHeldItem();
      // Geometrias de modelos GLB são compartilhadas entre instâncias: só descarta as exclusivas
      if (!targetObj.userData.modelKey) {
        targetObj.traverse((child) => { if (child.isMesh && child.geometry) child.geometry.dispose(); });
      }
      if (targetObj.parent) targetObj.parent.remove(targetObj);
      for (let i = obstacles.length - 1; i >= 0; i--) if (obstacles[i].group === targetObj) obstacles.splice(i, 1);
      for (let i = dynamicObstacles.length - 1; i >= 0; i--) if (dynamicObstacles[i].group === targetObj) dynamicObstacles.splice(i, 1);
      for (let i = grabbableItems.length - 1; i >= 0; i--) if (grabbableItems[i].group === targetObj) grabbableItems.splice(i, 1);
      for (let i = loaded3DModels.length - 1; i >= 0; i--) if (loaded3DModels[i].model === targetObj) loaded3DModels.splice(i, 1);
      setStatusBanner(`🗑️ ${objName} excluído!`, '#ff5252');
      logInteractionEvent(`🗑️ Desenvolvedor excluiu: ${objName}`);
    }
    devBtnDeleteEl.addEventListener('click', deleteSelectedDevObject);

    // Superfícies grandes que não devem ser selecionadas/movidas
    const devUnselectable = new Set([bedroomFloor, deskTop, deskmat, stripedRug, raceTrackPlane, puddleMesh]);
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (!devModeActive || isFreeCameraActive || e.button !== 0) return;
      if (transformControl.dragging || transformControl.axis !== null) return; // clique no gizmo
      devMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      devMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      devRaycaster.setFromCamera(devMouse, camera);
      const devHits = devRaycaster.intersectObjects([deskWorld, bedroomWorld], true).filter((h) => {
        const m = h.object;
        if (!m.visible || devUnselectable.has(m)) return false;
        return m.material !== wallMat && m.material !== baseboardMat;
      });
      if (!devHits.length) return;
      let selectedGroup = devHits[0].object;
      while (selectedGroup.parent && selectedGroup.parent !== deskWorld && selectedGroup.parent !== bedroomWorld) {
        selectedGroup = selectedGroup.parent;
      }
      if (devUnselectable.has(selectedGroup)) return;
      devSelectedObject = selectedGroup;
      transformControl.attach(selectedGroup);
      const name = selectedGroup.name || selectedGroup.userData.name || 'Objeto 3D';
      devSelectedNameEl.textContent = name;
      logInteractionEvent('🛠️ Objeto selecionado: ' + name);
    });

    // Inserir modelo da biblioteca à frente do carrinho (mesmo nível) e selecioná-lo
    devBtnAddModelEl.addEventListener('click', () => {
      const key = devSelectModelEl.value;
      if (!key) {
        notify({ type: 'info', title: 'Escolha um modelo', description: 'Use a lista ao lado do botão Inserir', duration: 2400 });
        return;
      }
      const onDesk = vehicle.position.y > -15;
      const x = vehicle.position.x + Math.sin(carAngle) * 6;
      const z = vehicle.position.z + Math.cos(carAngle) * 6;
      placeModel(key, {
        x, z, floor: !onDesk, rotY: carAngle,
        id: 'dev_user_model_' + Date.now(),
        onLoad: (model) => {
          devSelectedObject = model;
          transformControl.attach(model);
          devSelectedNameEl.textContent = model.name;
          setStatusBanner(`✓ ${model.name} inserido e selecionado!`, '#7ee787');
          logInteractionEvent(`🛠️ Modelo 3D inserido: ${model.name}`);
        }
      });
    });

    // Layout salvo: grava e (correção) reaplica ao iniciar
    const LAYOUT_STORAGE_KEY = 'ravi_desk_custom_layout';
    devBtnSaveEl.addEventListener('click', () => {
      const savedLayout = dynamicObstacles.filter(o => o.group).map(o => ({
        name: o.name, x: o.group.position.x, y: o.group.position.y, z: o.group.position.z, rotY: o.group.rotation.y
      }));
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayout));
        notify({ type: 'success', title: 'Layout salvo', description: `${savedLayout.length} objetos guardados neste navegador`, duration: 3000 });
        logInteractionEvent('💾 Layout dos objetos salvo pelo desenvolvedor.');
      } catch (err) {
        notify({ type: 'danger', title: 'Não foi possível salvar', description: 'O armazenamento do navegador está indisponível', duration: 3500 });
      }
    });

    function applySavedLayout() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
      if (!Array.isArray(saved)) return;
      const used = new Set();
      saved.forEach((entry) => {
        const obs = dynamicObstacles.find(o => o.group && o.name === entry.name && !used.has(o));
        if (!obs) return;
        used.add(obs);
        obs.group.position.set(entry.x, entry.y, entry.z);
        obs.group.rotation.y = entry.rotY || 0;
        obs.x = entry.x; obs.z = entry.z;
        obs.level = levelOfY(entry.y);
        obs.restOffset = entry.y - surfaceBaseY(entry.y);
      });
      if (used.size) logInteractionEvent(`💾 Layout salvo reaplicado (${used.size} objetos)`);
    }

    applyQuality();
    // Só em desenvolvimento (localhost): expõe cena, renderer e câmera para o Three.js DevTools MCP / depuração.
    // Nunca no site publicado. (Sem process.env: este é um script de navegador, sem bundler.)
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      window.__THREE__ = { scene, renderer, camera };
    }
    updateWaterHUD();
    updateBatteryHUD();
    renderAchievements();
    renderLeaderboard();
    cullOtherScene();
    if (IS_QUINTAL) {
      // O carrinho nasce na largada do rally (a posição padrão é na mesa, fora dos limites do quintal)
      const st = rallyStartLocation();
      vehicle.position.set(st.x, FLOOR_CAR_Y, st.z);
      carAngle = st.angle;
      vehicle.rotation.set(0, carAngle, 0);
    }
    animate();

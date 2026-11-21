// =============================================================================
// Nuvem: login com Google (Firebase Auth) + banco simples (Firestore)
// -----------------------------------------------------------------------------
// Dados guardados por usuário (mínimo necessário — sem e-mail, sem foto):
//   users/{uid}   → apelido de 3 letras, conquistas, cores do carrinho, recordes pessoais
//   laps/{uid}    → melhor volta do usuário (ranking global, leitura pública)
//   bowling/{uid} → melhor pontuação no boliche (ranking global, leitura pública)
// As regras em firestore.rules garantem que cada usuário só escreve nos próprios documentos
// e validam formato/limites de todos os campos. O jogo continua 100% offline sem configuração.
// =============================================================================
const SDK = '10.12.2';
const CFG = window.FIREBASE_CONFIG;
const listeners = new Set();

const cloud = {
  enabled: false,   // Firebase configurado e carregado
  ready: false,     // terminou de inicializar (com ou sem Firebase)
  user: null,       // { uid, name } do usuário logado
  error: null,
  onChange(fn) { listeners.add(fn); try { fn(cloud); } catch (e) { /* ignora */ } return () => listeners.delete(fn); }
};
window.cloud = cloud;

function emit() {
  listeners.forEach((fn) => { try { fn(cloud); } catch (e) { console.warn('[cloud] listener', e); } });
  window.dispatchEvent(new CustomEvent('cloud-change'));
}

// ---------- Validação no cliente (as regras do Firestore validam de novo no servidor) ----------
const TAG_RE = /^[A-Z0-9]{3}$/;
const LAP_MIN = 20000, LAP_MAX = 3600000;
const isInt = (n) => Number.isInteger(n);
function cleanTag(tag) {
  const t = String(tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return TAG_RE.test(t) ? t : null;
}
const COLOR_RE = /^#[0-9a-f]{6}$/;
function cleanProfile(p) {
  const out = {};
  if (p.tag && cleanTag(p.tag)) out.tag = cleanTag(p.tag);
  if (typeof p.paint === 'string' && /^[a-z0-9_-]{1,24}$/.test(p.paint)) out.paint = p.paint;
  if (p.custom && typeof p.custom === 'object') {
    const c = {};
    ['body', 'wheels', 'tires', 'glass'].forEach((k) => { if (typeof p.custom[k] === 'string' && COLOR_RE.test(p.custom[k])) c[k] = p.custom[k]; });
    out.custom = c;
  }
  if (isInt(p.bestLapMs) && p.bestLapMs >= LAP_MIN && p.bestLapMs <= LAP_MAX) out.bestLapMs = p.bestLapMs;
  if (isInt(p.bowlingBest) && p.bowlingBest >= 0 && p.bowlingBest <= 100000) out.bowlingBest = p.bowlingBest;
  if (p.achievements && typeof p.achievements === 'object') {
    const a = p.achievements, ach = { unlocked: {}, progress: {}, sets: {} };
    const ID = /^[a-zA-Z0-9_]{1,32}$/;
    Object.entries(a.unlocked || {}).slice(0, 64).forEach(([k, v]) => { if (ID.test(k) && isInt(v) && v > 0) ach.unlocked[k] = v; });
    Object.entries(a.progress || {}).slice(0, 64).forEach(([k, v]) => { if (ID.test(k) && isInt(v) && v >= 0 && v <= 10000) ach.progress[k] = v; });
    Object.entries(a.sets || {}).slice(0, 32).forEach(([k, v]) => {
      if (ID.test(k) && Array.isArray(v)) ach.sets[k] = v.filter(x => typeof x === 'string' && x.length <= 40).slice(0, 64);
    });
    out.achievements = ach;
  }
  return out;
}

async function init() {
  if (!CFG || !CFG.apiKey || !CFG.projectId) { cloud.ready = true; emit(); return; }
  try {
    const base = `https://www.gstatic.com/firebasejs/${SDK}`;
    const [appMod, authMod, fs] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);
    const app = appMod.initializeApp(CFG);
    if (window.FIREBASE_APPCHECK_SITE_KEY) {
      // Testes locais: token de depuração do App Check (NUNCA no site publicado).
      // Na primeira vez o SDK imprime o token no console; cadastre-o em App Check → Gerenciar tokens de depuração.
      const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (isLocal) self.FIREBASE_APPCHECK_DEBUG_TOKEN = window.FIREBASE_APPCHECK_DEBUG_TOKEN || true;
      const ac = await import(`${base}/firebase-app-check.js`);
      // Provedor atual: Google Cloud Fraud Defense (ex-reCAPTCHA Enterprise). O reCAPTCHA v3 clássico foi
      // descontinuado para novos cadastros no App Check; 'v3' só para registros antigos que ainda existam.
      const Provider = window.FIREBASE_APPCHECK_PROVIDER === 'v3' ? ac.ReCaptchaV3Provider : ac.ReCaptchaEnterpriseProvider;
      cloud.appCheck = ac.initializeAppCheck(app, { provider: new Provider(window.FIREBASE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
      cloud.appCheckEnabled = true;
    }
    const auth = authMod.getAuth(app);
    auth.languageCode = 'pt';
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    const db = fs.getFirestore(app);
    const uid = () => (auth.currentUser ? auth.currentUser.uid : null);

    cloud.signIn = async () => {
      const provider = new authMod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await authMod.signInWithPopup(auth, provider); }
      catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await authMod.signInWithRedirect(auth, provider);
        else if (!(e && e.code === 'auth/popup-closed-by-user')) throw e;
      }
    };
    cloud.signOut = () => authMod.signOut(auth);

    cloud.loadProfile = async () => {
      if (!uid()) return null;
      const snap = await fs.getDoc(fs.doc(db, 'users', uid()));
      return snap.exists() ? snap.data() : null;
    };
    cloud.saveProfile = async (profile) => {
      if (!uid()) return;
      const data = cleanProfile(profile || {});
      data.updatedAt = fs.serverTimestamp();
      await fs.setDoc(fs.doc(db, 'users', uid()), data, { merge: true });
    };
    // Ranking: um documento por usuário, só é atualizado quando o novo resultado é melhor
    cloud.submitLap = async (tag, timeMs) => {
      const t = cleanTag(tag), ms = Math.round(timeMs);
      if (!uid() || !t || !(ms >= LAP_MIN && ms <= LAP_MAX)) return false;
      const ref = fs.doc(db, 'laps', uid());
      return fs.runTransaction(db, async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists() && cur.data().time <= ms) return false;
        tx.set(ref, { tag: t, time: ms, updatedAt: fs.serverTimestamp() });
        return true;
      });
    };
    cloud.topLaps = async (n = 10) => {
      const q = fs.query(fs.collection(db, 'laps'), fs.orderBy('time', 'asc'), fs.limit(Math.min(25, n)));
      const res = await fs.getDocs(q);
      return res.docs.map(d => ({ name: d.data().tag, time: d.data().time, mine: d.id === uid() }));
    };
    cloud.submitBowling = async (tag, score) => {
      const t = cleanTag(tag) || 'JOG', s = Math.round(score);
      if (!uid() || !(s > 0 && s <= 100000)) return false;
      const ref = fs.doc(db, 'bowling', uid());
      return fs.runTransaction(db, async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists() && cur.data().score >= s) return false;
        tx.set(ref, { tag: t, score: s, updatedAt: fs.serverTimestamp() });
        return true;
      });
    };
    cloud.topBowling = async (n = 10) => {
      const q = fs.query(fs.collection(db, 'bowling'), fs.orderBy('score', 'desc'), fs.limit(Math.min(25, n)));
      const res = await fs.getDocs(q);
      return res.docs.map(d => ({ name: d.data().tag, score: d.data().score, mine: d.id === uid() }));
    };
    // Direito ao esquecimento (LGPD): apaga tudo o que foi guardado deste usuário
    cloud.deleteMyData = async () => {
      if (!uid()) return;
      const batch = fs.writeBatch(db);
      ['users', 'laps', 'bowling'].forEach((c) => batch.delete(fs.doc(db, c, uid())));
      await batch.commit();
    };

    authMod.onAuthStateChanged(auth, (u) => {
      cloud.user = u ? { uid: u.uid, name: (u.displayName || '').split(' ')[0] || 'Jogador' } : null;
      emit();
    });
    authMod.getRedirectResult(auth).catch(() => { /* sem redirecionamento pendente */ });
    cloud.enabled = true;
    cloud.ready = true;
    emit();
  } catch (e) {
    console.warn('[cloud] Firebase indisponível:', e);
    cloud.error = 'Não foi possível conectar ao servidor. Seu progresso continua salvo neste aparelho.';
    cloud.ready = true;
    emit();
  }
}
init();

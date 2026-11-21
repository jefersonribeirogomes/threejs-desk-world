// Configuração do Firebase (login com Google + Firestore) — veja o passo a passo em docs/FIREBASE.md
//
// Estes valores NÃO são segredos: eles só identificam o projeto no navegador. A segurança vem de:
//   1. Regras do Firestore (firestore.rules): cada usuário só lê/grava os PRÓPRIOS dados, com validação de formato;
//   2. Domínios autorizados no Firebase Authentication (apenas o domínio do site);
//   3. Restrição da chave de API por referenciador HTTP no Google Cloud Console;
//   4. App Check com reCAPTCHA v3 (opcional, recomendado) — bloqueia chamadas que não vêm do site.
//
// Enquanto FIREBASE_CONFIG for null, o site funciona normalmente só com o salvamento local do navegador.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAzP3OV0H2nOpzqz6VNDuvpGWiEailroKs",
  authDomain: "jeferson-deskwork-interative.firebaseapp.com",
  projectId: "jeferson-deskwork-interative",
  storageBucket: "jeferson-deskwork-interative.firebasestorage.app",
  messagingSenderId: "357767695383",
  appId: "1:357767695383:web:892e80a661c8c8df2ee052"
};
// App Check (opcional, recomendado): chave de site do Google Cloud Fraud Defense (ex-reCAPTCHA Enterprise),
// tipo "Site" com verificação por pontuação. Ela é pública. Passo a passo em docs/FIREBASE.md (passo 9).
window.FIREBASE_APPCHECK_SITE_KEY = null;


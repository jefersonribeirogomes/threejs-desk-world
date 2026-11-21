// Configuração do Firebase (login com Google + Firestore) — veja o passo a passo em docs/FIREBASE.md
//
// Estes valores NÃO são segredos: eles só identificam o projeto no navegador. A segurança vem de:
//   1. Regras do Firestore (firestore.rules): cada usuário só lê/grava os PRÓPRIOS dados, com validação de formato;
//   2. Domínios autorizados no Firebase Authentication (apenas o domínio do site);
//   3. Restrição da chave de API por referenciador HTTP no Google Cloud Console;
//   4. App Check com reCAPTCHA v3 (opcional, recomendado) — bloqueia chamadas que não vêm do site.
//
// Enquanto FIREBASE_CONFIG for null, o site funciona normalmente só com o salvamento local do navegador.
window.FIREBASE_CONFIG = null;
/* Exemplo (preencha com os dados do SEU projeto):
window.FIREBASE_CONFIG = {
  apiKey: 'AIza...',
  authDomain: 'seu-projeto.firebaseapp.com',
  projectId: 'seu-projeto',
  appId: '1:000000000000:web:abc123'
};
*/
// Chave de site do reCAPTCHA v3 usada pelo App Check (opcional)
window.FIREBASE_APPCHECK_SITE_KEY = null;

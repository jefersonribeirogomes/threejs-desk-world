# Login com Google + ranking global (Firebase)

O site funciona **sem** isto: recordes e conquistas ficam no `localStorage` do navegador.
Ao configurar o Firebase, o jogador pode entrar com a conta Google para:

- sincronizar conquistas, cores do carrinho e recordes entre aparelhos;
- aparecer no **ranking global** da volta no circuito e do boliche.

## O que é guardado (minimização de dados / LGPD)

| Coleção | Documento | Campos | Quem lê | Quem grava |
|---|---|---|---|---|
| `users` | `{uid}` | `tag` (3 letras), `paint`, `custom` (4 cores), `bestLapMs`, `bowlingBest`, `achievements`, `updatedAt` | só o dono | só o dono |
| `laps` | `{uid}` | `tag`, `time`, `updatedAt` | público | só o dono, e só se o tempo for **menor** |
| `bowling` | `{uid}` | `tag`, `score`, `updatedAt` | público | só o dono, e só se a pontuação for **maior** |

Não guardamos e-mail, foto nem nome completo. O botão **Apagar meus dados**, no menu, remove os três
documentos do usuário (direito de exclusão).

## Passo a passo

1. Crie um projeto em <https://console.firebase.google.com> (o Google Analytics pode ficar desligado).
2. Em **Authentication → Sign-in method**, ative o provedor **Google**.
3. Em **Authentication → Settings → Authorized domains**, deixe apenas `localhost` e o domínio do site
   (`jefersonribeirogomes.github.io`).
4. Em **Firestore Database**, crie o banco em **modo de produção** (região `southamerica-east1`).
5. Em **Firestore → Regras**, cole o conteúdo de [`firestore.rules`](../firestore.rules) e publique.
   (Ou, com a Firebase CLI: `firebase deploy --only firestore:rules`.)
6. Em **Firestore → Índices**, nenhum índice composto é necessário (as consultas ordenam por um único campo).
7. Em **Configurações do projeto → Seus apps**, adicione um app **Web** e copie o objeto de configuração para
   [`firebase-config.js`](../firebase-config.js) (`window.FIREBASE_CONFIG = { ... }`).
8. **Restrinja a chave de API** no Google Cloud Console (APIs e serviços → Credenciais → a chave "Browser key"):
   - Restrição de aplicativo: *Referenciadores HTTP* → `https://jefersonribeirogomes.github.io/*` e `http://localhost:*/*`;
   - Restrição de API: Identity Toolkit API, Token Service API e Cloud Firestore API.
9. (Recomendado) **App Check**: em *App Check*, registre o app Web com **reCAPTCHA v3**, cole a chave do site em
   `window.FIREBASE_APPCHECK_SITE_KEY` e ative a *aplicação obrigatória* (enforcement) para o Firestore.

## Notas de segurança

- A configuração do Firebase não é segredo; a proteção está nas **regras**, nos **domínios autorizados**,
  na **restrição da chave** e no **App Check**.
- As regras negam tudo por padrão, aceitam apenas os campos listados, validam formato e limites
  (`tag` `^[A-Z0-9]{3}$`, tempo entre 20 s e 1 h, pontuação de 0 a 100.000) e só deixam melhorar um recorde.
- Pontuações geradas no navegador sempre podem ser forjadas por alguém determinado. Para um ranking à prova de
  fraude, o próximo passo seria validar as voltas numa **Cloud Function** (ex.: conferir os tempos parciais de cada
  portal) e só ela gravar em `laps`.
- A página usa **Content-Security-Policy** limitando scripts, frames e conexões ao próprio site, ao Google/Firebase
  e ao YouTube (rádio). `'unsafe-inline'` ainda é necessário porque o jogo é um único `index.html` com script embutido.

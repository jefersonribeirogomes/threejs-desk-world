# 🚒 //Fire Engine// Desk World — Three.js Interactive Setup

Um mundo 3D interativo em **Three.js (r128)** inspirado em Bruno Simon: o cenário jogável é uma mesa de desenvolvedor expandida + o quarto, e o veículo é o caminhãozinho de bombeiro **`//Fire Engine//`**.

## 🎮 Controles

| Tecla | Ação |
| --- | --- |
| `W A S D` / setas | Dirigir |
| `Espaço` | Jato d'água (no modo dev: câmera livre com o mouse) |
| `F` | Pular |
| `E` | Pegar / soltar objeto |
| `V` | Trocar câmera |
| `M` | Mapa (fast travel) |
| `U` | Destravar (volta à última posição segura) |
| `Esc` | Menu |
| `F2` | Modo dev (mover, girar, inserir e excluir objetos) |
| Scroll | Zoom |

No celular aparecem o direcional e a barra de ações (Pular · Pegar · Água).

Também: `Enter` interage com ilhas, rádio e notebook · `Shift` boost · `H` buzina · `R` volta para a largada.
Controle (DualSense/Xbox): L2 acelera, R2 ré, analógico esquerdo dirige, ○ boost, △ pula, ▢ freia, ✕ interage, L1 hidráulica, R1 água, analógico direito câmera, Create volta à largada, Options abre o menu.

## 🏁 Circuito, ilhas e itens interativos

- Pista original que contorna a mesa, desce a rampa de papelão, cruza o quarto embaixo da mesa e sobe de volta, com 6 portais, cronômetro e ranking local (menu › Circuito).
- Ilhas no quarto (Posto do Bombeiro, Espacial, Música, Brinquedos e Lago) com grama, folhagem e água em shader.
- Rádio da mesa toca o canal oficial no YouTube Music; o notebook mostra LinkedIn e Trailhead no monitor.
- Os cadernos da mesa listam conquistas, recordes e pinturas; alimentos e plantinhas quebram com batidas; a caixinha de clipes derruba clipes ao ser arrastada.

## 🎨 Design system

A interface parte do design system de Bruno Simon (`assets/css/bruno-ds.css`, fontes em `assets/fonts`, ícones em `assets/ui`): intro com anel de carregamento, triggers de menu/mapa, toasts, tooltips e mapa com pins de viagem rápida.

O menu é o **Caderno do Ravi**: folha pautada com espiral, foto polaroide da cena e abas de post-it (no celular, uma faixa de adesivos embaixo):

| Aba | O que tem |
| --- | --- |
| 🚒 Garagem | Continuar, mapa, pinturas e troca de veículo (caminhãozinho ou Baja 13) |
| 🗺️ Mundos | Quarto, Quintal e Sala (em reforma), com as moedas de cada um |
| 🏁 Corridas | Recordes do circuito, do rally e do boliche, ranking e largada |
| ⭐ Álbum | Conquistas como figurinhas e as pinturas desbloqueadas |
| 👨‍💻 Sobre | Currículo: LinkedIn, Trailhead, YouTube Music e Piratas do Vale |
| 🎮 Controles | Teclado, celular (analógico) e controle |
| ⚙️ Ajustes | Áudio, qualidade, direção (suave/normal/rápida), tamanho do analógico, modo canhoto, dia e noite, câmeras |
| 📓 Diário | Registro de eventos e créditos |

## 🧱 Física

Passo fixo de 60 Hz (mesma velocidade em qualquer monitor), pulos/quedas com gravidade e quique, rampas com inclinação do carro, colisões separadas por nível (mesa × chão), empurrões com conservação de momento e objetos que caem da mesa até o chão.

## 📦 Modelos

Os GLBs em `models/` vêm sem materiais; o jogo os encaixa pelo bounding box real, coloca o pivô na base e aplica pintura procedural por face (`MODEL_LIBRARY` em `index.html`).

## 🔐 Conta, ranking global e segurança

- Login opcional com **Google** (Firebase Auth) e banco **Firestore** para sincronizar conquistas, cores do carrinho e recordes, além do **ranking global** de voltas e do boliche.
- Sem configuração, tudo funciona offline com o salvamento local do navegador.
- Dados mínimos (apelido de 3 letras, recordes, conquistas e cores), sem e-mail ou foto; botão **Apagar meus dados** no menu.
- Regras do Firestore com negação por padrão e validação de todos os campos: [`firestore.rules`](firestore.rules).
- Content-Security-Policy, restrição de chave por domínio e App Check: passo a passo em [`docs/FIREBASE.md`](docs/FIREBASE.md).

## 🚪 Cenários (uma página por ambiente)

| Página | Cenário | Como chegar |
| --- | --- | --- |
| `index.html` | Quarto + mesa (circuito, ilhas, caminhãozinho do Ravi) | Página inicial |
| `quintal.html` | Quintal: rally do Baja 13, Ilha do Baja, Ilha da Fogueira, Ilha do 86 (AE86 + Shiba), montanha da cachoeira | Porta na parede leste do quarto |
| — | Sala (em reforma) | Porta da frente do quarto |

As duas páginas usam o mesmo motor (`assets/js/world.js`); cada uma define `window.DESK_SCENE` e só constrói/simula o próprio cenário. O `quintal.html` é gerado a partir do `index.html`: depois de mudar a interface do `index.html`, rode `node scripts/gerar-quintal.mjs`.

## 🙏 Inspiração e créditos

- **Inspiração:** [Bruno Simon](https://bruno-simon.com/): o portfólio interativo em 3D dele inspirou este mundo e o design system da interface.
- **Modelos e referências:** [Kenney](https://kenney.nl/): pacotes de modelos 3D e sons em domínio público (CC0), referência e primeira opção para os assets do projeto.
- **Natureza do quintal:** [Quaternius](https://quaternius.com/), Ultimate Stylized Nature (CC0).
- **Props do quarto:** [Kay Lousberg / KayKit](https://kaylousberg.itch.io/), Mixed Bag 2 (CC0).
- **Carro estacionado no quintal:** "[Toyota AE86](https://poly.pizza/m/ZEFWmOPSgh)" por [IvOfficial](https://poly.pizza/u/IvOfficial), licenciado em [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (via Poly Pizza; textura e formato originais).

- **Mais modelos:** Quaternius via Poly Pizza (Shiba Inu, pombo, hidrante, viatura; CC0), Kenney Cube Pets (gato e pintinhos; CC0), "[Fire Truck](https://poly.pizza/m/7iHJ519SwxG)" por Ivan Klus e "[Swing set](https://poly.pizza/m/e-IJdcqZH4p)" por Poly by Google ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)).
- **Sons do Freesound:** "[Night time crickets call](https://freesound.org/people/Clearwavsound/sounds/523439/)" por Clearwavsound ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)) e "[Tires on Gravel Road 1](https://freesound.org/people/OBXJohn/sounds/251661/)" por OBXJohn (CC0).

Lista completa de modelos e onde aparecem: [`models/CREDITS.md`](models/CREDITS.md) e [`models/kenney/CREDITS.md`](models/kenney/CREDITS.md).

## 🚀 Como rodar localmente

```bash
npx http-server . -p 8085
# ou
python -m http.server 8085
```

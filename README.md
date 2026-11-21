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
| `Esc` | Menu |
| `F2` | Modo dev (mover, girar, inserir e excluir objetos) |
| Scroll | Zoom |

No celular aparecem o direcional e a barra de ações (Pular · Pegar · Água).

## 🎨 Design system

A interface usa o design system de Bruno Simon (`assets/css/bruno-ds.css`, fontes em `assets/fonts`, ícones em `assets/ui`): intro com anel de carregamento, triggers de menu/mapa, menu split-pane (Início, Opções, Controles, Conquistas, Bastidores), toasts de notificação, conquistas com pinturas desbloqueáveis, tooltips e mapa com pins de viagem rápida.

## 🧱 Física

Passo fixo de 60 Hz (mesma velocidade em qualquer monitor), pulos/quedas com gravidade e quique, rampas com inclinação do carro, colisões separadas por nível (mesa × chão), empurrões com conservação de momento e objetos que caem da mesa até o chão.

## 📦 Modelos

Os GLBs em `models/` vêm sem materiais; o jogo os encaixa pelo bounding box real, coloca o pivô na base e aplica pintura procedural por face (`MODEL_LIBRARY` em `index.html`).

## 🚀 Como rodar localmente

```bash
npx http-server . -p 8085
# ou
python -m http.server 8085
```

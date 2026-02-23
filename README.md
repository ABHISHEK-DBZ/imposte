# Imposter - Online Multiplayer Social Deduction Game

A real-time multiplayer social deduction party game where players try to find the imposter among them.

## How to Play

1. **Grand Master** creates a room and sets two secret words (one normal, one imposter)
2. Players join the room using the room code
3. Each player secretly receives a word — most get the normal word, but the imposter(s) get a different one
4. Players take turns giving one-word hints about their word
5. After discussion, players vote to eliminate who they think the imposter is
6. **People win** if all imposters are eliminated. **Imposters win** if they outnumber the normal players

## Features

- Online multiplayer with real-time room-based gameplay
- Grand Master mode — host controls the game as an observer
- Real-time chat system
- Voice chat via WebRTC peer-to-peer audio
- Local play mode for same-device gameplay
- Built-in word packs with shuffle
- Customizable settings (imposter count, discussion timer)
- Score tracking across games
- Responsive design for mobile and desktop

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Backend:** Node.js, Express
- **Real-time:** Socket.IO
- **Voice:** WebRTC with STUN servers

## Setup

```bash
npm install
node server.js
```

Open `http://localhost:3000` in your browser.

## Deployment

Deploy to any Node.js hosting platform that supports WebSockets (Render, Railway, etc.).

## Author

**Abhishek Jha** - Full Stack Developer

- GitHub: [@ABHISHEK-DBZ](https://github.com/ABHISHEK-DBZ)

# Setup — Windows + WSL2

End-to-end first-run for a powerful Windows machine. Mac/Linux users: most steps still apply; skip WSL.

---

## 0. Hardware sanity check

| Component | Minimum | Comfortable |
|---|---|---|
| RAM | 16 GB | 32 GB+ |
| GPU | none (CPU-only Ollama works) | NVIDIA RTX with ≥ 8 GB VRAM |
| Storage | 50 GB free | 100 GB+ SSD |
| CPU | 8 cores | Ryzen 7 / i7 or better |

The GPU is the difference between "DeepSeek-R1 is usable" and "DeepSeek-R1 is fast." Not required for Phase 0–1 if you don't mind 10–20s reasoning steps locally; Claude handles the user-facing output anyway.

---

## 1. Enable WSL2

PowerShell, run as Administrator:

```powershell
wsl --install
```

This installs WSL2 + Ubuntu by default. Reboot when prompted.

Verify after reboot:

```powershell
wsl --status         # WSL 2 should be the default version
wsl -l -v            # Ubuntu, VERSION 2, STATE Running
```

If WSL is already installed but on version 1:

```powershell
wsl --set-default-version 2
wsl --set-version Ubuntu 2
```

---

## 2. NVIDIA GPU passthrough (skip if no NVIDIA GPU)

1. Install the latest NVIDIA driver **on Windows** (not inside WSL): https://www.nvidia.com/Download/index.aspx
2. Inside WSL Ubuntu, verify:

```bash
nvidia-smi
```

If you see your GPU, you're done. Do **not** install NVIDIA drivers inside WSL — the Windows driver provides them via the kernel.

---

## 3. Inside Ubuntu (WSL): base toolchain

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl ca-certificates
```

### Node via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# restart shell, then:
nvm install 22
nvm use 22
nvm alias default 22
node -v          # v22.x
```

### pnpm

```bash
npm install -g pnpm
pnpm -v
```

---

## 4. Ollama

**Install Ollama on Windows (not inside WSL).** This lets it use the NVIDIA GPU directly and exposes a server on `localhost:11434` that WSL can reach.

1. Download and run: https://ollama.com/download/windows
2. After install, Ollama runs as a service on `http://localhost:11434`.
3. Pull the models we use:

```powershell
ollama pull deepseek-r1
ollama pull qwen3
ollama pull nomic-embed-text
```

**Verify from inside WSL:**

```bash
curl http://localhost:11434/api/tags
```

You should see the three models listed. If you get `Connection refused`, check that Ollama is running on Windows and that WSL2 networking is in "mirrored" mode or that you're using `http://host.docker.internal:11434` instead. Set `OLLAMA_BASE_URL` accordingly in `.env.local`.

> Why Windows-side, not WSL? GPU passthrough for Ollama inside WSL works but is finicky. Running on the host is simpler and faster.

---

## 5. ChromaDB

Easiest: Docker.

### Docker Desktop

1. Install: https://www.docker.com/products/docker-desktop/
2. In settings → Resources → WSL Integration: enable Ubuntu.
3. Verify in WSL: `docker ps`

### Run Chroma

```bash
docker run -d --name chroma -p 8000:8000 -v chroma-data:/chroma/chroma chromadb/chroma:latest
```

Verify: `curl http://localhost:8000/api/v1/heartbeat`

---

## 6. Playwright deps (for the crawl worker, in WSL)

The crawl worker runs inside WSL. Playwright needs system libs:

```bash
sudo apt install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
  libpango-1.0-0 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libasound2t64 libxshmfence1
```

The `playwright install` command (run later after `pnpm install`) will fetch the browser binaries. Don't pre-install browsers globally.

---

## 7. VS Code + Remote-WSL

1. Install VS Code on Windows: https://code.visualstudio.com/
2. Install the **Remote - WSL** extension.
3. From Ubuntu: `code .` opens VS Code attached to WSL. Everything (terminal, debugger, extensions for the project) now runs Linux-side.

Recommended extensions to install **into the WSL environment** (not Windows):

- Claude Code
- ESLint
- Prettier
- Tailwind CSS IntelliSense
- GitLens
- vscode-zod

---

## 8. Clone and bootstrap

**Put the repo on the Linux filesystem, not `/mnt/c/...`.** Disk I/O across the WSL boundary is dramatically slower.

```bash
cd ~
mkdir -p code && cd code
git clone <repo-url> gravitas-agentic-ai
cd gravitas-agentic-ai
```

Then once the project is scaffolded (Phase 0):

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env.local
# fill in the values — see ARCHITECTURE.md → Environment variables
```

---

## 9. Environment variables

`.env.local` (dev). Get these from:

- `ANTHROPIC_API_KEY` — https://console.anthropic.com/
- `SUPABASE_URL` / keys — Supabase project settings
- `OLLAMA_BASE_URL` — usually `http://localhost:11434` (or `http://host.docker.internal:11434` if WSL networking is in NAT mode)
- `CHROMA_URL` — `http://localhost:8000`
- `CRAWL_WORKER_URL` — `http://localhost:8787` in dev

See `docs/ARCHITECTURE.md` for the full list with descriptions.

---

## 10. First-run

Three terminals (or three VS Code panes), all inside WSL:

```bash
# Terminal 1 — Next.js
pnpm dev

# Terminal 2 — Crawl worker
pnpm dev:worker

# Terminal 3 — anything else
```

Then open http://localhost:3000/copilot in a Windows browser. WSL2 forwards localhost transparently.

**Smoke checks** (all should pass before you call setup done):

1. Page loads, dual-pane layout visible
2. Send a chat message → response streams back
3. Send the keyword `debug` → a `DebugAction` renders in the canvas
4. `curl http://localhost:11434/api/tags` shows Ollama models
5. `curl http://localhost:8787/health` returns OK from the crawl worker
6. `pnpm lint && pnpm typecheck && pnpm test` pass

---

## Common WSL gotchas

| Symptom | Fix |
|---|---|
| `EACCES` on `npm install -g` | Use nvm; never `sudo npm`. |
| Ollama unreachable from WSL | Check Windows firewall isn't blocking 11434. Try `http://host.docker.internal:11434`. |
| Painfully slow `pnpm install` | Repo is on `/mnt/c/...`. Move it to `~/`. |
| Playwright "browser not found" | Run `pnpm exec playwright install chromium` inside WSL. |
| GPU not detected by Ollama | Latest NVIDIA driver on Windows; restart Ollama service. |
| Chroma "connection refused" | Container stopped. `docker start chroma`. |
| `node-gyp` build failures | `sudo apt install -y python3 make g++`. |

---

## When you upgrade hardware or Windows

- WSL2 survives most Windows updates but verify `wsl --status` afterwards.
- Re-test GPU passthrough with `nvidia-smi` inside WSL.
- `nvm install --reinstall-packages-from=22 22` if you bump Node.

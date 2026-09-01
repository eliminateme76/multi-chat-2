# Sceneweaver Runbook

## First setup in WSL Ubuntu

```bash
sudo apt update
sudo apt install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER sceneweaver WITH PASSWORD 'sceneweaver_dev_password';"
sudo -u postgres psql -c "CREATE DATABASE sceneweaver OWNER sceneweaver;"

cd /mnt/c/Users/user/Documents/GitHub/multi-ai-chat
cp .env.example .env
npm install
npm run db:setup
npm install -g @openai/codex@latest
mkdir -p "$HOME/.codex-sceneweaver"
CODEX_HOME="$HOME/.codex-sceneweaver" codex login
```

Set `SCENEWEAVER_CODEX_HOME` in `.env` to the absolute path printed by `cd "$HOME/.codex-sceneweaver" && pwd`. This keeps app-server sessions separate from the interactive CLI session list.

The `CREATE USER` and `CREATE DATABASE` commands are needed only once. If they report that the resource already exists, continue.

## Daily startup

```bash
cd /mnt/c/Users/user/Documents/GitHub/multi-ai-chat
sudo service postgresql start
set -a; . ./.env; set +a
CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status
npm run dev
```

The app listens on port `3000`. Use `http://localhost:3000` first. If Windows cannot reach the WSL localhost-forwarded port:

```bash
hostname -I
```

Then use `http://<first-WSL-IP>:3000` in the Windows browser. The WSL IP can change after WSL restarts.

## Health checks

```bash
pg_isready
curl http://127.0.0.1:3000/api/state
codex --version
set -a; . ./.env; set +a
CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status
```

## Reset story data

```bash
cd /mnt/c/Users/user/Documents/GitHub/multi-ai-chat
npm run reset:demo
```

This removes all current scene entries and restores the initial three demo messages. It does not recreate the database schema or characters.

## Troubleshooting

### `connect ECONNREFUSED ...:5432`

The Node server is likely running on Windows instead of WSL, or PostgreSQL is stopped. Run both PostgreSQL and Node in WSL.

```bash
sudo service postgresql start
npm run dev
```

### Codex turn fails

```bash
codex --version
set -a; . ./.env; set +a
CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login status
```

Install/update and authenticate inside WSL if needed:

```bash
npm install -g @openai/codex@latest
set -a; . ./.env; set +a
mkdir -p "$SCENEWEAVER_CODEX_HOME"
CODEX_HOME="$SCENEWEAVER_CODEX_HOME" codex login
```

### Repeated turns appear unexpectedly

Turn off **자동 진행** in the UI. It sends a turn every five seconds. Use `npm run reset:demo` to clear accumulated logs.

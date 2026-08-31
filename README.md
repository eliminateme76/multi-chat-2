# Sceneweaver

AI 캐릭터가 하나의 세계 안에서 대화하고, 사용자가 사건을 투입해 장면을 바꾸는 웹 MVP입니다.

Codex로 이어서 개발할 때는 먼저 [AGENTS.md](./AGENTS.md)를 읽으세요. 실행 및 장애 대응 절차는 [RUNBOOK.md](./RUNBOOK.md)에 있습니다.

## 실행

Node.js + Express + PostgreSQL 앱입니다. **WSL Ubuntu**에서 아래 순서로 PostgreSQL을 준비하고 실행하세요.

```powershell
sudo apt update
sudo apt install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER sceneweaver WITH PASSWORD 'sceneweaver_dev_password';"
sudo -u postgres psql -c "CREATE DATABASE sceneweaver OWNER sceneweaver;"

cd /mnt/c/Users/user/Documents/GitHub/multi-ai-chat
cp .env.example .env
npm install
npm run db:setup
npm run dev
```

기본적으로 브라우저에서 `http://localhost:3000`을 여세요. WSL의 localhost 포트 전달이 비활성화된 환경에서는 Ubuntu에서 아래 명령으로 IP를 확인한 후 `http://<WSL_IP>:3000`으로 접속해야 합니다.

```bash
hostname -I
```

예: `http://192.168.112.146:3000`

세계관, 캐릭터, 관계, 장면 로그는 PostgreSQL에 저장됩니다.

## 현재 MVP 동작

- 세계관/장면 편집
- 캐릭터 Agent 생성 및 수정, AI 초안 채우기(현재는 로컬 초안)
- 캐릭터별 개인 상태: 목표, 비밀, 감정, 관계
- Director 순서에 따른 Codex Agent 대화 턴 생성
- 사용자 사건 투입 및 전개 제안
- 자동 진행

반복된 데모 대화 로그를 초기 장면으로 되돌리려면 WSL에서 `npm run reset:demo`를 실행하세요.

## Codex app-server 연결 구조

브라우저가 Codex app-server에 직접 연결하지 않습니다. Ubuntu의 서버 측 프로세스가 app-server와 통신하고, 앱 DB가 영속 상태를 관리합니다.

```text
Browser UI → App API / DB → Codex app-server (stdio JSON-RPC)
```

`POST /api/turns`는 실제 Codex app-server를 stdio JSON-RPC로 호출합니다. 현재 화자 Agent의 성격, 말투, 목표, 비밀, 감정, 관계와 최근 공개 장면 로그를 프롬프트로 보낸 뒤, Codex의 구조화 JSON 응답을 PostgreSQL에 저장합니다.

앱 서버를 실행하는 WSL Ubuntu에 Codex CLI가 설치·로그인되어 있어야 합니다.

```bash
npm install -g @openai/codex@latest
codex login
codex --version
```

이 프로젝트는 `.env`의 `CODEX_MODEL`과 `CODEX_TURN_TIMEOUT_MS`로 Codex 모델 및 최대 턴 시간을 설정합니다. 현재 구현은 요청마다 app-server 프로세스와 새 Codex thread를 생성합니다. 따라서 캐릭터의 영구 기억은 Codex thread가 아니라 PostgreSQL의 캐릭터/관계/장면 로그에서 관리됩니다.

```json
{
  "speakerId": "sera",
  "dialogue": "대사",
  "action": "행동 묘사",
  "emotion": "경계",
  "relationshipChanges": [{ "targetId": "luca", "delta": -2 }],
  "directorNote": "다음 진행 메모"
}
```

캐릭터 요청에는 공용 장면 정보와 **그 캐릭터가 아는 공개 로그·개인 기억만** 포함하세요. 비밀과 전체 세계 상태는 Director 요청/DB에만 보관해 정보가 누출되지 않게 합니다.
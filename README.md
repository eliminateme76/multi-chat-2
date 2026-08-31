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

상단의 세계관 선택 메뉴에서 로컬 DB에 저장된 프로젝트를 전환할 수 있습니다. `다음 턴 진행`은 현재 장면에서 캐릭터 한 명의 대사와 행동을 생성하고, 사건 투입은 기존 장면을 보존한 채 새 장면을 시작합니다.

실행 단계와 지연 시간은 `http://localhost:3000/monitor.html`에서 실시간으로 확인할 수 있습니다. 실제 프롬프트와 캐릭터 비밀은 모니터에 전송하지 않습니다.

## 현재 MVP 동작

- 세계관/장면 편집
- 캐릭터 Agent 생성 및 수정, 현재 장면 기반 Codex 추천
- 캐릭터별 개인 상태: 목표, 비밀, 감정, 관계
- Director 순서에 따른 Codex Agent 대화 턴 생성
- 사용자 사건 투입 및 전개 제안
- 자동 진행

반복된 데모 대화 로그를 초기 장면으로 되돌리려면 WSL에서 `npm run reset:demo`를 실행하세요.

## Codex app-server 연결 구조

브라우저가 Codex app-server에 직접 연결하지 않습니다. Ubuntu의 서버가 하나의 app-server 프로세스를 재사용하며, 각 생성 요청에는 새 thread를 사용합니다. 캐릭터 정체성·기억과 이야기 상태의 기준은 PostgreSQL입니다.

```text
Browser UI → App API / DB → Codex app-server (stdio JSON-RPC)
```

`POST /api/turns`는 실제 Codex app-server를 stdio JSON-RPC로 호출합니다. 현재 화자의 Character Card, 개인 기억, 관계, 활성 장면 요약과 최근 공개 그룹 로그를 조립합니다. 구조화된 응답은 검증 후 공개 메시지, 감정, 개인 기억, 관계 변화와 장면 신호로 한 트랜잭션에 저장됩니다. 자세한 설계는 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)를 참고하세요.

앱 서버를 실행하는 WSL Ubuntu에 Codex CLI가 설치·로그인되어 있어야 합니다.

```bash
npm install -g @openai/codex@latest
codex login
codex --version
```

이 프로젝트는 `.env`의 `CODEX_MODEL`과 `CODEX_TURN_TIMEOUT_MS`로 Codex 모델 및 최대 턴 시간을 설정합니다. app-server 프로세스는 재사용하고 생성 요청마다 새 Codex thread를 만듭니다. 캐릭터의 영구 기억은 thread가 아니라 PostgreSQL의 캐릭터·관계·장면·개인 기억 테이블에서 관리됩니다.

```json
{
  "dialogue": "대사",
  "action": "행동 묘사",
  "emotion": "경계",
  "memory": "이 캐릭터만 기억할 새 사실",
  "memoryImportance": 75,
  "relationshipChanges": [{ "targetId": "luca", "delta": -2 }],
  "sceneSignal": "continue"
}
```

캐릭터 요청에는 공용 장면 정보와 **그 캐릭터가 아는 공개 로그·개인 기억만** 포함하세요. 비밀과 전체 세계 상태는 Director 요청/DB에만 보관해 정보가 누출되지 않게 합니다.

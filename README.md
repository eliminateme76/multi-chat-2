# Sceneweaver

Concordia Entity로 구성된 AI 캐릭터가 하나의 세계 안에서 행동하고, World GM이 환경 결과와 장면 진행을 판정하는 웹 시뮬레이터입니다. 모델 호출은 API 키가 아니라 Codex app-server를 사용합니다.

Codex로 이어서 개발할 때는 먼저 [AGENTS.md](./AGENTS.md)를 읽으세요. 실행 및 장애 대응 절차는 [RUNBOOK.md](./RUNBOOK.md)에 있습니다.

## 실행

Node.js + Express + PostgreSQL 앱입니다. **WSL Ubuntu**에서 아래 순서로 PostgreSQL을 준비하고 실행하세요.

```powershell
sudo apt update
sudo apt install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER sceneweaver WITH PASSWORD 'sceneweaver_dev_password';"
sudo -u postgres psql -c "CREATE DATABASE sceneweaver_concordia OWNER sceneweaver;"

cd /home/codex_home/multi-chat-2
cp .env.example .env
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-concordia.txt
npm run db:setup
mkdir -p "$HOME/.codex-sceneweaver-concordia"
CODEX_HOME="$HOME/.codex-sceneweaver-concordia" codex login
npm run dev
```

`.env`의 `SCENEWEAVER_CODEX_HOME`에는 위에서 로그인한 디렉터리의 절대 경로를 지정하세요. 앱 전용 Codex 홈은 일반 CLI의 설정·인증·세션과 분리되며, 생성이 끝난 일회성 thread는 자동으로 구독 해제 후 삭제됩니다.

기본적으로 브라우저에서 `http://localhost:3200`을 여세요. WSL의 localhost 포트 전달이 비활성화된 환경에서는 Ubuntu에서 아래 명령으로 IP를 확인한 후 `http://<WSL_IP>:3200`으로 접속해야 합니다.

```bash
hostname -I
```

예: `http://192.168.112.146:3200`

세계관, 캐릭터, 관계, 장면 로그는 PostgreSQL에 저장됩니다.

상단의 세계관 선택 메뉴에서 로컬 DB에 저장된 프로젝트를 전환할 수 있습니다. `다음 턴 진행`은 현재 장면에서 캐릭터 한 명의 대사와 행동을 생성하고, 사건 투입은 기존 장면을 보존한 채 새 장면을 시작합니다.

실행 단계와 지연 시간은 `http://localhost:3200/monitor.html`에서 실시간으로 확인할 수 있습니다. Concordia worker/Entity/GM 단계와 내부 Codex thread를 함께 표시하며, 실제 프롬프트와 캐릭터 비밀은 모니터에 전송하지 않습니다.

## 현재 MVP 동작

- 세계관/장면 편집
- 캐릭터 Agent 생성 및 수정, 현재 장면 기반 Codex 추천
- 캐릭터별 개인 상태: 목표, 비밀, 감정, 관계
- Director 순서에 따른 Codex Agent 대화 턴 생성
- 사용자 사건 투입 및 전개 제안
- 자동 진행

반복된 데모 대화 로그를 초기 장면으로 되돌리려면 WSL에서 `npm run reset:demo`를 실행하세요.

## Concordia + Codex app-server 연결 구조

브라우저가 Concordia worker나 Codex app-server에 직접 연결하지 않습니다. Node 서버가 stdio Python worker와 하나의 app-server 프로세스를 관리합니다. Python은 Codex 자격증명을 갖지 않고 Node로 역호출하며, 캐릭터와 World Director는 각자 활성 thread를 재사용합니다. 캐릭터 정체성·기억과 이야기 상태의 기준은 PostgreSQL입니다.

```text
Browser UI → Express / PostgreSQL → Concordia 2.4 worker (stdio JSONL)
                                      ↳ Node reverse model callback → Codex app-server
```

`POST /api/turns`는 실제 Concordia Entity의 한 단계를 실행합니다. 현재 화자의 Character Card, 개인 기억, 관계, 활성 장면 요약과 볼 수 있는 사건을 조립하고 Codex app-server로 구조화된 행동을 생성합니다. 캐릭터 결과가 저장되면 같은 내구 작업에서 World GM이 환경 결과·사건·장면·다음 응답자를 판정합니다. 자세한 설계는 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)를 참고하세요.

앱 서버를 실행하는 WSL Ubuntu에 Codex CLI가 설치되어 있어야 하며, 앱 전용 `SCENEWEAVER_CODEX_HOME`에 로그인되어 있어야 합니다.

```bash
npm install -g @openai/codex@latest
mkdir -p "$HOME/.codex-sceneweaver-concordia"
CODEX_HOME="$HOME/.codex-sceneweaver-concordia" codex login
CODEX_HOME="$HOME/.codex-sceneweaver-concordia" codex login status
codex --version
```

이 프로젝트는 `.env`의 `CODEX_MODEL`과 `CODEX_TURN_TIMEOUT_MS`로 Codex 모델 및 최대 턴 시간을 설정합니다. 활성 thread는 정해진 턴/문맥 토큰 한도까지 재사용한 뒤 DB 상태로 새 thread를 구성합니다. 캐릭터의 영구 기억은 thread가 아니라 PostgreSQL의 캐릭터·관계·장면·개인 기억 테이블에서 관리됩니다.

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

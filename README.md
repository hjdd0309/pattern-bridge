# 🧠 Pattern Bridge

> **말 안 해도 먼저 챙겨주는 AI 미들레이어**

Pattern Bridge는 사용자의 컴퓨터 행동 패턴을 백그라운드에서 수집·분석하고, 평소 루틴을 놓쳤을 때 AI 에이전트(OpenClaw)에 신호를 보내 **AI가 먼저 말을 겁니다.**

---

## 📐 연구 범위 (Scope)

이 프로젝트는 **단일 사용자(1인) 데이터를 기반으로 한 사례 연구(case study)** 입니다. 아래 범위를 벗어난 주장은 하지 않습니다.

- **데이터 규모**: 브라우저 히스토리는 최초 실행 시 최근 30일치를 백필(backfill)하며, 이후 창 포커스 / 파일 입출력 / 키 입력 횟수 등은 실시간(1초~5분 간격 폴링)으로 계속 수집됩니다. 본 저장소에 포함된 정량 평가 수치(정밀도, ablation 비교표 등)는 모두 이 1인 사용자의 로컬 데이터베이스(`data/pattern-bridge.sqlite`) 하나에서 산출된 것입니다.
- **검증 대상**: 3-알고리즘 앙상블(베이지안 / PrefixSpan / FFT)이 *이 사용자의* 사용 패턴에서 얼마나 정확하게 "놓침"을 감지하는지를 `notification_log` 기반 피드백(👍/👎)으로 정량화합니다 (`npm run eval-report`, `npm run ablation`).
- **범위 밖 — 향후 과제**: 여러 사용자에 걸친 일반화 가능성(다중 사용자 검증), 사용자 간 행동 패턴의 이질성에 대한 강건성, 장기간(수개월 이상)에 걸친 개념 변화(concept drift) 분석은 이번 연구의 범위에 포함되지 않으며 향후 과제로 남겨둡니다.

---

## 💡 핵심 아이디어

기존 AI 어시스턴트는 사용자가 말해야 반응합니다.

Pattern Bridge는 이걸 뒤집습니다:

```
사용자가 아무 말도 안 함
↓
Pattern Bridge: "매일 9시에 Chrome 여는데 오늘 32분째 안 열었네"
↓
OpenClaw에 webhook 신호
↓
텔레그램: "오늘 Chrome 아직 안 여셨어요 👀"
```

---

## 🏗️ 시스템 구조

```
pattern-bridge/
├── src/
│   ├── collector/               # 데이터 수집
│   │   ├── window-monitor.ts    # 활성 창 감지 (1초마다)
│   │   ├── browser-history.ts   # 크롬 히스토리 수집 (5분마다)
│   │   ├── file-monitor.ts      # 파일 열기/저장 감지
│   │   ├── keyboard-monitor.ts  # 키보드 입력 횟수 카운트
│   │   └── app-time.ts          # 앱별 사용시간 계산
│   ├── analyzer/                # 패턴 분석
│   │   ├── pattern-engine.ts    # 3가지 알고리즘 앙상블
│   │   ├── missed-detector.ts   # 놓침 감지
│   │   └── check-patterns.ts    # CLI 패턴 뷰어
│   ├── trigger/
│   │   └── openclaw-client.ts   # OpenClaw webhook 클라이언트
│   ├── scheduler/
│   │   └── index.ts             # 크론 스케줄러
│   └── ui/                      # Electron 대시보드
├── config/config.ts
└── ecosystem.config.cjs         # PM2 설정
```

---

## 🔬 패턴 분석 알고리즘

3가지 알고리즘 앙상블로 행동 패턴을 감지합니다:

| 알고리즘 | 가중치 | 감지 내용 |
|---------|--------|----------|
| 베이지안 시간대 분석 | 40% | "매일 10시에 Chrome 열 확률 87%" |
| PrefixSpan 시퀀스 마이닝 | 35% | "VSCode → Chrome → KakaoTalk 순서로 항상 전환" |
| FFT 주기 분석 | 25% | "24시간, 168시간(1주일) 주기 사용 패턴" |

**최종 신뢰도 = 0.40 × 베이지안 + 0.35 × PrefixSpan + 0.25 × FFT**

신뢰도 ≥ 75% + 2개 이상 알고리즘 동의 → 패턴 저장

### 놓침 감지
감지된 패턴의 예상 시간이 10분 이상 경과했는데 해당 앱을 사용하지 않은 경우 → OpenClaw webhook 호출 → 텔레그램 알림

---

## ⚙️ 기술 스택

- **언어**: TypeScript
- **런타임**: Node.js v24
- **DB**: SQLite (better-sqlite3)
- **백그라운드**: PM2
- **UI**: Electron
- **AI 에이전트**: OpenClaw + Gemini 2.5 Flash
- **알림**: 텔레그램 봇

---

## 🚀 시작하기

### 사전 요구사항
- Node.js v20+
- PM2 (`npm install -g pm2`)
- OpenClaw (WSL2)
- 텔레그램 봇 토큰

### 설치

```bash
git clone https://github.com/hjdd0309/pattern-bridge.git
cd pattern-bridge
npm install
```

### 환경 설정

```bash
cp .env.example .env
```

`.env` 수정:

```
OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/hooks/agent
OPENCLAW_TOKEN=your-secret-token
NOTIFY_CHANNEL=telegram          # 또는 discord
NOTIFY_TO=your-chat-or-channel-id # 텔레그램 chat id / 디스코드 채널 ID
```

### 실행

```bash
# 백그라운드 수집 시작
pm2 start ecosystem.config.cjs

# 패턴 분석 결과 확인
npx tsx src/analyzer/check-patterns.ts

# Electron UI 실행
npm run ui
```

---

## 📊 수집 데이터

| 데이터 | 방법 | 주기 |
|--------|------|------|
| 활성 창/앱 이름 | OS API | 1초마다 |
| 브라우저 방문 URL | 크롬 히스토리 파일 직접 읽기 | 5분마다 |
| 파일 열기/저장 | 파일시스템 감시 | 실시간 |
| 키보드 입력 횟수 | 글로벌 훅 (횟수만, 내용 아님) | 1분마다 |
| 앱별 사용시간 | 창 이벤트 집계 | 요청 시 |

> ⚠️ 모든 데이터는 **로컬에만 저장**됩니다. 외부 서버로 전송되는 데이터는 없으며, 본인이 직접 운영하는 OpenClaw 인스턴스로만 webhook이 호출됩니다.

### 공개 데이터셋 (익명화)

실제 수집한 데이터(이벤트 164,551건, 탐지 패턴 607건, 알림 10건)를 익명화해 `dataset/pattern-bridge-anon.sqlite`로 포함했습니다.

- **유지**: 이벤트 종류, 발생 시각, 앱 이름, 탐지 패턴, 알림 로그 — 패턴 엔진이 읽는 값은 원본과 동일
- **제거**: 창 제목, 파일 경로(확장자만 남김), 브라우저 URL(도메인만 남김)
- **추가**: 창 제목, 도메인, 앱 이름으로 판단한 활동 카테고리 `category`(`entertainment`, `sns`, `study`, `work`, `leisure`, `exercise`, `communication`, `shopping`, `finance`, `search`, `system`, `other`)와, 해당하면 세부 분류 `subcategory`(`shortform`, `video`, `game`, `webtoon` 등)

카테고리 규칙은 `config/categories.json`에 있습니다. 위에서부터 순서대로 검사해 처음 맞는 규칙을 적용하며, 공개 데이터셋 변환 DB에도 같은 규칙을 적용했습니다.

이 DB로 바로 실행하려면:

```powershell
$env:DB_PATH = "dataset/pattern-bridge-anon.sqlite"; npm run ui
```

익명화 사본은 `python scripts/anonymize-data.py`로 다시 만들 수 있습니다. 시연용 소량 DB는 `dataset/pattern-bridge-demo-anon.sqlite`(이벤트 692건)입니다.

### 외부 공개 데이터셋

일반화 검증에 쓴 외부 공개 데이터셋을 `dataset/public/`에 포함했습니다. 각 폴더의 `pattern-bridge-*.sqlite`는 원본을 Pattern Bridge 스키마(`user_events`)로 변환한 것입니다. 라이선스와 인용 조건은 각 원본 데이터셋을 따릅니다.

| 데이터셋 | 폴더 | 원본 파일 | 변환 DB |
|---------|------|-----------|---------|
| BEHACOM (PC 사용 행동, 12명) | `dataset/public/behacom/` | `Behacom.zip`, `behacom-slim.csv` | 이벤트 40,581건 |

> OpenClaw는 PC에서 동작하므로 폰 데이터셋(LSApp, LiveLab)은 포함하지 않습니다.

#### PC·노트북 데이터셋 (OpenClaw 대상 환경)

개입 판단 레이어 검증에는 아래 PC 데이터셋을 사용합니다. 변환 스크립트는 `scripts/import-public-pc.py`입니다. 타임스탬프는 주 단위로 옮겨서 시간대와 요일을 그대로 유지했습니다.

| 데이터셋 | 폴더 | 내용 | 라이선스 |
|---------|------|------|---------|
| [Labelled AWT](https://github.com/project-pivot/labelled-awt-data) (Beerepoot, 2024) | `dataset/public/awt/` | 1명의 4주 치 활성 창 로그(앱, 창 제목, 시작·종료 시각) 10,066건. 창마다 수동으로 단 활동 라벨이 있음 | GPL-3.0 |
| [SWELL-KW](https://doi.org/10.17026/dans-x55-69zp) (Koldijk 외, 2014) | `dataset/public/swell/` | 25명이 휴식, 보통, 방해, 시간 압박 조건에서 일할 때의 분 단위 키보드·마우스·앱 전환 특징 3,139분 | CC BY-NC-SA 4.0 |
| [GESIS Web Tracking](https://zenodo.org/records/4757574) (Kulshrestha 외, 2021) | `dataset/public/gesis/` | 독일 사용자 2,148명의 한 달 치 웹 방문 9,151,243건(도메인, 방문 시각, 활성 시간). 도메인마다 41종 카테고리가 붙어 있음 | CC BY-NC 4.0 |

- GESIS는 원본 `browsing.csv`(680MB)에서 쓰는 컬럼만 남겨 `browsing-compact.csv.gz`(49MB)로 넣었습니다. 9,151,243건 전체가 들어 있습니다.
- 엔진에 바로 넣을 수 있는 `pattern-bridge-gesis-sample50.sqlite`는 사용자 50명을 시드 고정으로 뽑은 표본입니다(208,054건). 인원을 바꾸려면 아래처럼 다시 만듭니다.

```powershell
$env:GESIS_USERS = "50"; python scripts/import-public-pc.py gesis dataset/public/gesis dataset/public/gesis/pattern-bridge-gesis-sample50.sqlite
```

---

## 🔒 프라이버시

- 키보드 **횟수만** 기록 — 입력 내용은 절대 저장하지 않음
- 모든 데이터는 로컬 SQLite DB에만 저장
- 브라우저 히스토리는 로컬에서만 읽고 외부로 전송하지 않음
- OpenClaw + 텔레그램 봇을 직접 운영

---

## 📄 라이선스

MIT
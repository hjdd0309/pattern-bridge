markdown# 🧠 Pattern Bridge

> **말 안 해도 먼저 챙겨주는 AI 미들레이어**

Pattern Bridge는 사용자의 컴퓨터 행동 패턴을 백그라운드에서 수집·분석하고, 평소 루틴을 놓쳤을 때 AI 에이전트(OpenClaw)에 신호를 보내 **AI가 먼저 말을 겁니다.**

---

## 💡 핵심 아이디어

기존 AI 어시스턴트는 사용자가 말해야 반응합니다.

Pattern Bridge는 이걸 뒤집습니다:
사용자가 아무 말도 안 함
↓
Pattern Bridge: "매일 9시에 Chrome 여는데 오늘 32분째 안 열었네"
↓
OpenClaw에 webhook 신호
↓
텔레그램: "오늘 Chrome 아직 안 여셨어요 👀"

---

## 🏗️ 시스템 구조

'''
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
'''

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
OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/hooks/agent
OPENCLAW_TOKEN=your-secret-token

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

---

## 🔒 프라이버시

- 키보드 **횟수만** 기록 — 입력 내용은 절대 저장하지 않음
- 모든 데이터는 로컬 SQLite DB에만 저장
- 브라우저 히스토리는 로컬에서만 읽고 외부로 전송하지 않음
- OpenClaw + 텔레그램 봇을 직접 운영

---

## 📄 라이선스

MIT
import os from "os";
import { getDb } from "../src/db/schema.js";

// getDb() creates data/ and the schema if missing, so seeding works on a fresh clone
const db = getDb();

// Same user id the collectors and missed-detector use
const userId = os.hostname();
const now = Date.now();
const DAY = 86_400_000;
const days = 30;

const insert = db.prepare(`
  INSERT INTO user_events (user_id, action, metadata, occurred_at)
  VALUES (?, ?, ?, ?)
`);

const insertMany = db.transaction(() => {
  for (let d = 0; d < days; d++) {
    const base = now - (days - d) * DAY;

    // 매일 09:00~09:08 노트북 켜고 Chrome으로 SK하이닉스 검색
    const morning = new Date(base);
    morning.setHours(9, Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0);

    insert.run(userId, "window_focus", JSON.stringify({
      app: "Google Chrome",
      title: "SK하이닉스 - 네이버 검색",
    }), morning.getTime());

    insert.run(userId, "browser_visit", JSON.stringify({
      url: "https://search.naver.com/search.naver?query=SK%ED%95%98%EC%9D%B4%EB%8B%89%EC%8A%A4+%EC%A3%BC%EA%B0%80",
      title: "SK하이닉스 주가 - 네이버 검색",
    }), morning.getTime() + 90_000 + Math.random() * 60_000);

    insert.run(userId, "browser_visit", JSON.stringify({
      url: "https://finance.naver.com/item/main.naver?code=000660",
      title: "SK하이닉스 : 네이버 금융",
    }), morning.getTime() + 180_000 + Math.random() * 60_000);

    // 매일 13:20~13:45 이캠퍼스 접속
    const afternoon = new Date(base);
    afternoon.setHours(13, 20 + Math.floor(Math.random() * 25), Math.floor(Math.random() * 60), 0);

    insert.run(userId, "window_focus", JSON.stringify({
      app: "Google Chrome",
      title: "LMS | 이캠퍼스",
    }), afternoon.getTime());

    insert.run(userId, "browser_visit", JSON.stringify({
      url: "https://ecampus.khu.ac.kr/login.php",
      title: "LMS | 이캠퍼스 로그인",
    }), afternoon.getTime() + 30_000);

    insert.run(userId, "browser_visit", JSON.stringify({
      url: "https://ecampus.khu.ac.kr/ilos/main/course/list_form.acl",
      title: "LMS | 이캠퍼스 - 내 강의실",
    }), afternoon.getTime() + 90_000 + Math.random() * 60_000);
  }
});

insertMany();
console.log(`✅ ${days}일치 샘플 데이터 삽입 완료`);
console.log(`  - 매일 09:00~09:08 SK하이닉스 주가 확인 (네이버 금융)`);
console.log(`  - 매일 13:20~13:45 이캠퍼스 접속`);
db.close();
# 오늘 올라옴? — 앱인토스 버전

토스 앱 안에서 돌아가는 미니앱 버전이에요. 웹 버전(`../index.html`)과 다른 점:

- 라이트 모드 (앱인토스 필수)
- 알림·업로드 시간 기능 없음
- 하단에 TMDB 출처 표기

## 처음 한 번

1. Node.js 설치 (https://nodejs.org 의 LTS 버전)
2. 이 폴더에서:

```bash
npm install
npm install @apps-in-toss/web-framework
npx ait init
```

3. 생성된 `granite.config.ts`의 `appName`, `displayName`, `icon`을 앱인토스 콘솔에 등록한 값과 똑같이 맞추기
   - `web.commands`는 `dev: 'vite dev'`, `build: 'vite build'` 그대로 두면 돼요.
4. 앱인토스 콘솔 → CORS 허용 목록은 따로 필요 없음 (서버가 모든 출처 허용)

## 빌드 & 올리기

```bash
npm run build
```

생성된 `.ait` 파일을 앱인토스 콘솔에 업로드 → QR로 토스 앱에서 테스트 → 검토 요청.

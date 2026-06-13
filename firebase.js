const admin = require('firebase-admin');

let db;

function initFirebase() {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    return db;
  }

  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    try {
      serviceAccount = require('./serviceAccountKey.json');
    } catch {
      throw new Error('serviceAccountKey.json 파일이 없거나 FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });

  // Firebase Console에서 만든 Firestore (asia-northeast3) 명시적으로 지정
  db = admin.firestore();
  db.settings({
    ignoreUndefinedProperties: true,
    preferRest: true,
    databaseId: '(default)',
  });

  console.log(`✅ Firebase 초기화 완료 (프로젝트: ${serviceAccount.project_id})`);
  return db;
}

function getDb() {
  if (!db) return initFirebase();
  return db;
}

module.exports = { initFirebase, getDb };
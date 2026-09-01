/**
 * Print the Firestore security rules currently live on the project.
 *
 * There is no copy of them in this repo, and editing rules blind is how
 * you lock an app out of its own data. This mints a token from the same
 * service account the tracker uses and reads the active ruleset through
 * the Firebase Rules API. Read-only.
 */
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const PROJECT = serviceAccount.project_id;
const API = 'https://firebaserules.googleapis.com/v1';

async function main() {
  const token = await admin.credential.cert(serviceAccount)
    .getAccessToken()
    .then(t => t.access_token)
    .catch(async () => (await admin.app().options.credential.getAccessToken()).access_token);
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const rel = await fetch(`${API}/projects/${PROJECT}/releases`, auth).then(r => r.json());
  if (rel.error) throw new Error(`${rel.error.code} ${rel.error.message}`);

  const firestore = (rel.releases || []).find(r => r.name.endsWith('cloud.firestore'));
  if (!firestore) {
    console.log('No cloud.firestore release found. Releases:',
      (rel.releases || []).map(r => r.name).join(', ') || '(none)');
    process.exit(0);
  }
  console.log(`release: ${firestore.name}`);
  console.log(`ruleset: ${firestore.rulesetName}\n`);

  const rs = await fetch(`${API}/${firestore.rulesetName}`, auth).then(r => r.json());
  if (rs.error) throw new Error(`${rs.error.code} ${rs.error.message}`);
  for (const f of rs.source.files) {
    console.log(`----- ${f.name} -----`);
    console.log(f.content);
  }
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });

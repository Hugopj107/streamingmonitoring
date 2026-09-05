// Google Sheets writer (service-account auth). The sheet must be shared (Editor)
// with the service account's client_email. Appends one row per finished match.
const fs = require('fs');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const HEADER = ['Date', 'Tournament ID', 'Tournament', 'Court', 'Match', 'Players', 'Start', 'End', 'Uptime %',
  'Monitored (min)', 'Down (min)', 'Incidents', 'Longest (min)', 'MTTR (min)',
  'Change (min)', 'Frozen (min)', 'No signal (min)', 'No frames (min)', 'NATS address'];

let sheets = null, email = '', lastError = '';
const SPREADSHEET_ID = '1gv5-wkSyOKsn3U1iCfzdgOFMHFgRkUjrlSJ5HA4JWcg';   // fixed target sheet
const TAB = 'streams';                                                    // fixed tab

async function configure({ keyPath }) {
  try {
    if (!keyPath || !fs.existsSync(keyPath)) throw new Error('no key file at ' + keyPath);
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    if (!key.client_email || !key.private_key) throw new Error('placeholder/empty key — replace service-account.json with a real key');
    const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
    await auth.authorize();                              // fails fast on a bad key
    sheets = google.sheets({ version: 'v4', auth });
    email = key.client_email; lastError = '';
    await ensureHeader();                                // also verifies the sheet is shared with us
    return { ok: true, email };
  } catch (err) {
    sheets = null; lastError = String((err && err.message) || err);
    return { ok: false, error: lastError };
  }
}

async function ensureHeader() {
  // always refresh row 1 so schema changes (added columns) are reflected; data rows untouched
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [HEADER] },
  });
}

async function append(row) {
  if (!sheets) throw new Error('Sheets not configured');
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${TAB}!A1`, valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] },
  });
  // updatedRange looks like "streams!A7:S7" — pull the row number back so we can overwrite it later
  const m = String(res.data.updates && res.data.updates.updatedRange || '').match(/!\D+(\d+):/);
  return { ok: true, row: m ? Number(m[1]) : null };
}

async function updateRow(rowNum, row) {
  if (!sheets) throw new Error('Sheets not configured');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${TAB}!A${rowNum}`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  return { ok: true, row: rowNum };
}

const status = () => ({ ready: !!sheets, email, error: lastError });

module.exports = { configure, append, updateRow, status, HEADER };

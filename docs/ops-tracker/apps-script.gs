/**
 * HotelTrack — operations tracker push.
 *
 * Bound to a property's operations workbook. POSTs the tracker tab to HotelTrack
 * whenever the sheet changes, so the client report reflects an edit within
 * seconds and never has to read the document at render time.
 *
 * The workbook stays PRIVATE. This runs inside the Sheets runtime with the
 * editor's own authorisation — no publish-to-web, no service account, no OAuth
 * client, and no sharing change of any kind.
 *
 * ── SETUP ───────────────────────────────────────────────────────────────────
 *
 * 1. Extensions → Apps Script, and paste this file in.
 *
 * 2. Project Settings → Script Properties → add:
 *        INGEST_SECRET = <the value of OPS_TRACKER_INGEST_SECRET in Vercel>
 *    Never paste the secret into the script body. Script Properties are not
 *    included when a script is copied or shared; the body is.
 *
 * 3. Set TAB below to this workbook's tracker tab name, exactly as it appears on
 *    the sheet tab. It must match the tab registered against the property in
 *    HotelTrack, because (spreadsheetId, tabName) is the routing key.
 *
 * 4. Triggers → Add Trigger:
 *        Function:            pushTracker
 *        Event source:        From spreadsheet
 *        Event type:          On change          <-- NOT "On edit"
 *        Failure notification: notify me immediately
 *
 *    THIS STEP IS THE ONE THAT GOES WRONG. A simple onEdit(e) function cannot
 *    make external requests — UrlFetchApp is unavailable to simple triggers, and
 *    the failure is SILENT: the sheet looks fine and nothing ever arrives. Only
 *    an INSTALLABLE trigger, added through this menu, runs with the
 *    authorisation UrlFetchApp needs.
 *
 * 5. Run pushTracker once by hand to grant authorisation, then check
 *    Executions for the logged response.
 *
 * ── NOTES ───────────────────────────────────────────────────────────────────
 *
 * onChange fires on every committed edit, so this posts often. That is fine and
 * deliberate: the endpoint upserts on (spreadsheet, tab, date), so replaying an
 * identical payload changes nothing. Idempotency is the protection, not
 * debouncing.
 *
 * Dates are sent as yyyy-MM-dd formatted from the cell's underlying DATE VALUE,
 * not as the displayed string. A display string is locale-dependent — "05/09/2026"
 * is 5 September or 9 May depending on a spreadsheet setting nobody remembers
 * changing — and the server rejects anything it cannot read unambiguously.
 */

var ENDPOINT = 'https://www.hoteltrack.in/api/integrations/ops-tracker';
var TAB = 'Aster | Call Reports Tracker'; // <-- set per workbook

function pushTracker() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) {
    console.error('INGEST_SECRET is not set in Script Properties. Nothing sent.');
    return;
  }

  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(TAB);
  if (!sheet) {
    console.error('Tab "' + TAB + '" not found in this workbook. Nothing sent.');
    return;
  }

  var tz = ss.getSpreadsheetTimeZone();
  var range = sheet.getDataRange();
  var values = range.getValues();         // real types, including Date objects
  var display = range.getDisplayValues(); // fallback for non-date cells

  if (values.length < 2) {
    console.log('Nothing to send: sheet has no data rows.');
    return;
  }

  var header = display[0];

  // Which column is the date? Match on the header rather than assuming column A,
  // so inserting a column ahead of it does not silently send the wrong field.
  var dateCol = -1;
  for (var c = 0; c < header.length; c++) {
    if (String(header[c]).trim().toLowerCase() === 'date') { dateCol = c; break; }
  }

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var out = [];
    for (var c2 = 0; c2 < header.length; c2++) {
      var v = values[r][c2];
      if (c2 === dateCol && v instanceof Date) {
        out.push(Utilities.formatDate(v, tz, 'yyyy-MM-dd'));
      } else {
        out.push(display[r][c2]);
      }
    }
    // Skip rows with an empty date cell — trailing blank rows and separators.
    if (String(out[dateCol === -1 ? 0 : dateCol]).trim() === '') continue;
    rows.push(out);
  }

  var payload = {
    spreadsheetId: ss.getId(),
    tab: TAB,
    header: header,
    rows: rows,
    sentAt: new Date().toISOString()
  };

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  console.log(code + ' ' + body);

  // Surface a refusal in Executions rather than logging a 4xx as if it were a
  // success. The response body names the rows that were rejected and why.
  if (code >= 300) {
    throw new Error('HotelTrack ingest refused the payload: ' + code + ' ' + body);
  }
}

/**
 * HotelTrack — operations tracker push.
 *
 * Bound to the Aster operations workbook. POSTs each tracker tab to HotelTrack
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
 * 3. Check TABS below against the tab strip. The names are case- and
 *    space-sensitive and must match what is registered against each property in
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
 * ── WHY THIS SENDS THE WHOLE GRID ───────────────────────────────────────────
 *
 * It does NOT decide which row is the header or where the data starts. It sends
 * the sheet as it is and lets the server locate the table.
 *
 * The two tabs are shaped differently — CBH has its header on row 9 and data
 * from row 10; 3Hills has a BAND header on row 10, its real header on row 11,
 * data from row 12, and a second table off to the right in columns O..T. Any
 * rule for finding the table has to be written once and tested against both. It
 * cannot be tested here: this file is not reachable by the test suite, and a
 * copy of the rule living in it would drift from the real one silently. So the
 * rule lives in lib/ops-tracker/locate.ts, under test, and this script stays
 * dumb on purpose.
 *
 * getDataRange() is still the right way to GET the grid — it is the edges of it
 * that must not be trusted, and that judgement is the server's.
 *
 * Dates are sent as yyyy-MM-dd formatted from each cell's underlying DATE VALUE,
 * not as the displayed string. A display string is locale-dependent —
 * "05/09/2026" is 5 September or 9 May depending on a spreadsheet setting nobody
 * remembers changing — and the server rejects anything it cannot read
 * unambiguously.
 *
 * ── NOTES ───────────────────────────────────────────────────────────────────
 *
 * onChange fires on every committed edit, so this posts often. That is fine and
 * deliberate: the endpoint upserts on (spreadsheet, tab, date), so replaying an
 * identical payload changes nothing. Idempotency is the protection, not
 * debouncing.
 */

var ENDPOINT = 'https://www.hoteltrack.in/api/integrations/ops-tracker';

// Both properties, one workbook. Exactly as they appear on the tab strip.
var TABS = ['CBH', '3Hills'];

function pushTracker() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) {
    throw new Error('INGEST_SECRET is not set in Script Properties. Nothing sent.');
  }

  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone();
  var failures = [];

  for (var i = 0; i < TABS.length; i++) {
    try {
      pushOneTab(ss, TABS[i], tz, secret);
    } catch (err) {
      // Carry on to the other tab, then fail the run. One broken tab must not
      // stop the other from reporting, and must not be swallowed either.
      failures.push(TABS[i] + ': ' + (err && err.message ? err.message : err));
    }
  }

  if (failures.length > 0) {
    throw new Error('HotelTrack push failed for ' + failures.length + ' tab(s) — ' +
                    failures.join(' | '));
  }
}

function pushOneTab(ss, tabName, tz, secret) {
  var sheet = ss.getSheetByName(tabName);

  // A RENAMED OR MISSING TAB THROWS. It used to log and return, which is the
  // same shape of failure as sending an empty sheet: the trigger goes green, the
  // Executions log shows a tidy run, and the report quietly stops updating.
  // Throwing is what makes the trigger's failure notification fire.
  if (!sheet) {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    throw new Error('tab not found in this workbook. Tabs present: ' + names.join(', ') +
                    '. Nothing sent for this tab.');
  }

  var range = sheet.getDataRange();
  var values = range.getValues();         // real types, including Date objects
  var display = range.getDisplayValues(); // everything else, as shown

  if (values.length === 0) {
    throw new Error('sheet is empty. Nothing sent for this tab.');
  }

  // The whole rectangle, unedited. A Date becomes yyyy-MM-dd from its underlying
  // value; every other cell is its display string. No row or column is dropped
  // here — deciding which of them is the table is the server's job.
  var grid = [];
  for (var r = 0; r < values.length; r++) {
    var row = [];
    for (var c = 0; c < values[r].length; c++) {
      var v = values[r][c];
      row.push(v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : display[r][c]);
    }
    grid.push(row);
  }

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify({
      spreadsheetId: ss.getId(),
      tab: tabName,
      grid: grid,
      sentAt: new Date().toISOString()
    }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  console.log(tabName + ': ' + code + ' ' + body);

  // Surface a refusal rather than logging a 4xx as if it were a success. The
  // response body names what was rejected and why — including which step of the
  // table-location rule failed, when that is the problem.
  if (code >= 300) {
    throw new Error('ingest refused the payload: ' + code + ' ' + body);
  }
}

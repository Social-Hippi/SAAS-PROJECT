/* HotelTrack tracking snippet — vanilla JS, loads async.
   <script src="https://yourdomain.com/t.js?id=HOTEL_SITE_ID" async></script>
   Collects ONLY UTM + page data. Never names, emails, or form contents.

   SOURCE OF TRUTH: edit THIS file, then run `npm run build:snippet` to
   regenerate the minified public/t.js that hotels actually load. */
(function () {
  "use strict";
  try {
    // 1. Find our own <script> tag and read the Hotel Site ID from its src.
    var me = document.currentScript;
    if (!me || !me.src || me.src.indexOf("id=") < 0) {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        var ss = all[i].src || "";
        if (ss.indexOf("/t.js") >= 0 && ss.indexOf("id=") >= 0) { me = all[i]; break; }
      }
    }
    if (!me || !me.src) return;
    var src = new URL(me.src);
    var siteId = src.searchParams.get("id");
    if (!siteId) return;
    var base = src.origin;
    var DEBUG = src.searchParams.get("debug") === "1";

    var VERSION = "2.4.0"; // v2.4 adds ad click ids; v2.3 = coupon capture; v2.2 = click/form/identify; v2.1 = funnel stages; v2.0 = journeys; v1 = visit.
    var converted = false, observer = null, cfg = null, pending = false;
    var UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    // Ad-platform CLICK IDENTIFIERS (v2.4). Stronger evidence than a UTM: the
    // platform stamps these itself, so they survive an advertiser forgetting to
    // tag a link — and Google Ads AUTO-TAGGING (the default) sends gclid with NO
    // utm params at all, which is why those visits used to look "direct".
    //   gclid/gbraid/wbraid — Google Ads only (gbraid/wbraid are the iOS variants)
    //   fbclid              — Meta; note it is added to ORGANIC post links too
    var CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid"];
    var CLICK_MAX = 255; // real ids are ~60–100 chars; longer is not a click id
    // Funnel stages in order; rank = index + 1 (awareness=1 … booking=4).
    var STAGES = ["awareness", "consideration", "intent", "booking"];

    function log(t, p) {
      if (!DEBUG && !(typeof window !== "undefined" && window.HT_DEBUG)) return;
      try {
        console.log("[HotelTrack]", t, p);
        window.dispatchEvent(new CustomEvent("hoteltrack:event", { detail: { type: t, payload: p } }));
      } catch (e) {}
    }
    function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function getCookie(n) {
      var m = document.cookie.match("(?:^|; )" + n + "=([^;]*)");
      return m ? decodeURIComponent(m[1]) : null;
    }
    function setCookie(n, v, days) {
      var exp = "";
      if (days) { var d = new Date(); d.setTime(d.getTime() + days * 86400000); exp = "; expires=" + d.toUTCString(); }
      document.cookie = n + "=" + encodeURIComponent(v) + exp + "; path=/; SameSite=Lax";
    }
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
    function uuid() {
      try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
      // RFC4122-ish fallback for browsers without crypto.randomUUID.
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
    function device() {
      var ua = navigator.userAgent || "";
      if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return "tablet";
      if (/Mobi|Android|iPhone|iPod|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
      return "desktop";
    }

    // 3 + 4. First-touch attribution: store the FIRST UTM set seen for 30 days.
    function urlUtms() {
      var q = new URLSearchParams(location.search), o = {}, has = false;
      UTM.forEach(function (k) { var v = q.get(k); if (v) { o[k] = v; has = true; } });
      return has ? o : null;
    }
    var attr = parse(getCookie("_ht_attr") || "");
    if (!attr) {
      var cur = urlUtms();
      if (cur) { attr = cur; setCookie("_ht_attr", JSON.stringify(cur), 30); } // don't overwrite if cookie exists
    }
    attr = attr || {};

    // ── Ad click identifiers (v2.4) ────────────────────────────────────────
    // Captured from the LANDING url and held in a first-party cookie so they
    // survive internal navigation, later sessions, and the eventual conversion —
    // the query string is gone after the first click-through, so without this the
    // identifier would be lost on page 2. No third-party cookie, no localStorage.
    //
    // 90 days: Google Ads conversion windows run up to 90 days, so a shorter
    // cookie would drop evidence Google itself would still credit. The window is
    // SLIDING (re-stamped on every page) so an active visitor never ages out.
    var CLICK_KEY = "_ht_clk", CLICK_DAYS = 90;
    // Click ids are URL-safe tokens. A value outside that charset was tampered
    // with or mis-parsed — reject it rather than "clean" it into a different
    // string that could never match the ad platform's own records.
    function normClickId(v) {
      if (v == null) return null;
      var s = String(v).trim();
      if (!s || s.length > CLICK_MAX) return null;
      return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
    }
    function urlClickIds() {
      var q = new URLSearchParams(location.search), o = {}, has = false;
      CLICK_IDS.forEach(function (k) {
        var v = normClickId(q.get(k));
        if (v) { o[k] = v; has = true; }
      });
      return has ? o : null;
    }
    // Merge is per-key and ADD-ONLY: a page without a click id (every internal
    // navigation) can never erase one, while a genuinely new ad click replaces
    // that platform's value. A Meta click after a Google click keeps both.
    var clicks = parse(getCookie(CLICK_KEY) || "");
    if (!clicks || typeof clicks !== "object" || clicks instanceof Array) clicks = {};
    var landedClicks = urlClickIds();
    if (landedClicks) {
      CLICK_IDS.forEach(function (k) { if (landedClicks[k]) clicks[k] = landedClicks[k]; });
    }
    // Re-stamp on every load so the 90-day window slides for an active visitor.
    var hasClicks = false;
    CLICK_IDS.forEach(function (k) { if (clicks[k]) hasClicks = true; });
    if (hasClicks) setCookie(CLICK_KEY, JSON.stringify(clicks), CLICK_DAYS);
    // Copy of the stored ids for a payload. Only present keys are emitted, so an
    // event never carries `"gclid": null` noise.
    function clickIdPayload() {
      var o = {};
      CLICK_IDS.forEach(function (k) { if (clicks[k]) o[k] = clicks[k]; });
      return o;
    }
    function addClickIds(payload) {
      CLICK_IDS.forEach(function (k) { if (clicks[k]) payload[k] = clicks[k]; });
      return payload;
    }

    // Session id — per-tab browsing session held in sessionStorage, with a
    // 30-minute inactivity window. A new tab (fresh sessionStorage) or being idle
    // for >30 min starts a new session. "ht_session_last" records the last event
    // time for the idle check. Format: "sess_" + uuid.
    var IDLE_MS = 30 * 60 * 1000, sid = null;
    function newSid() { return "sess_" + uuid(); }
    function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
    function touchSession() { ssSet("ht_session_last", String(Date.now())); }
    function ensureSession() {
      var last = parseInt(ssGet("ht_session_last") || "0", 10);
      var cur = ssGet("ht_session_id");
      if (!cur || !(last > 0) || (Date.now() - last) > IDLE_MS) {
        cur = newSid();
        ssSet("ht_max_stage", "0"); // new session → reset funnel progress
        ssSet("ht_click_n", "0");   // new session → reset click/form client caps
        ssSet("ht_form_n", "0");
        ssSet("ht_identified", ""); // new session → re-link known identity once
      }
      sid = cur; ssSet("ht_session_id", sid); touchSession();
    }
    ensureSession();
    converted = getCookie("_ht_conv") === sid;

    // Persistent visitor id — survives across sessions (365-day cookie). Seeds
    // from the legacy _ht_vid cookie when present so returning visitors keep their
    // identity. Format: "vis_" + (legacy id | uuid).
    var vid = getCookie("ht_visitor_id");
    if (!vid) { var legacyVid = getCookie("_ht_vid"); vid = "vis_" + (legacyVid || uuid()); }
    setCookie("ht_visitor_id", vid, 365);

    // Multi-touch journey: append one touchpoint per page load that carries new
    // info (a UTM, or an external referrer, or the very first touch), de-duping
    // consecutive identical touches. Capped at 20 (oldest drop off). Cookie uses
    // the same 30-day sliding window. Still UTM + page/referrer only — no PII.
    var JKEY = "_ht_journey", JMAX = 20;
    function clip(s, n) { return s == null ? null : String(s).slice(0, n); }
    function hostOf(u) { try { return new URL(u).host; } catch (e) { return ""; } }
    function buildTouch() {
      var u = urlUtms() || {};
      var t = {
        ts: Date.now(),
        utm_source: u.utm_source || null, utm_medium: u.utm_medium || null,
        utm_campaign: u.utm_campaign || null, utm_content: u.utm_content || null,
        referrer: clip(document.referrer || null, 200),
        landing_page: clip(location.href, 200)
      };
      // Only THIS page's click ids (not the stored ones) belong on a touch — a
      // touch describes one marketing interaction, so stamping the remembered id
      // onto later touches would invent ad clicks that never happened.
      // Absent keys are omitted to keep the journey cookie small (it is capped at
      // 20 touches and browsers cap a cookie at ~4KB).
      var c = landedClicks || {};
      CLICK_IDS.forEach(function (k) { if (c[k]) t[k] = c[k]; });
      return t;
    }
    function sameTouch(a, b) {
      if (!a || !b) return false;
      // A new ad click is always a NEW touch, even on an otherwise identical page.
      for (var ci = 0; ci < CLICK_IDS.length; ci++) {
        if ((a[CLICK_IDS[ci]] || null) !== (b[CLICK_IDS[ci]] || null)) return false;
      }
      return a.utm_source === b.utm_source && a.utm_medium === b.utm_medium &&
        a.utm_campaign === b.utm_campaign && a.utm_content === b.utm_content && a.referrer === b.referrer;
    }
    var journey = parse(getCookie(JKEY) || "");
    if (!(journey instanceof Array)) journey = [];
    var tp = buildTouch();
    var hasUtm = !!(tp.utm_source || tp.utm_medium || tp.utm_campaign || tp.utm_content);
    var extRef = !!(tp.referrer && hostOf(tp.referrer) && hostOf(tp.referrer) !== location.host);
    // An ad click ALWAYS earns a touch. Auto-tagged Google traffic carries no UTM,
    // and its referrer can be stripped (referrer-policy, app→web), so without this
    // the strongest evidence we have would be dropped from the journey entirely.
    var hasClick = false;
    CLICK_IDS.forEach(function (k) { if (tp[k]) hasClick = true; });
    var lastTp = journey.length ? journey[journey.length - 1] : null;
    if ((hasUtm || hasClick || extRef || journey.length === 0) && !sameTouch(tp, lastTp)) {
      journey.push(tp);
      if (journey.length > JMAX) journey = journey.slice(journey.length - JMAX);
    }
    setCookie(JKEY, JSON.stringify(journey), 30); // sliding 30-day expiry

    // Transport — sendBeacon (no CORS preflight, survives unload) → fetch keepalive.
    var ENDPOINT = base + "/api/track/event";
    function post(data) {
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([data], { type: "text/plain;charset=UTF-8" }));
        else fetch(ENDPOINT, { method: "POST", body: data, headers: { "Content-Type": "text/plain;charset=UTF-8" }, mode: "cors", keepalive: true });
      } catch (e) {}
    }
    function viewportW() { return window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0; }
    function viewportH() { return window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0; }

    // Conversion event (TrackingEvent). Carries first-touch UTM so attribution is
    // unchanged, and attaches the multi-touch journey. Uses the v2 session/visitor
    // ids so a session can be linked to its booking.
    function send(type, value) {
      ensureSession();
      var payload = {
        siteId: siteId, type: type, v: VERSION, visitorId: vid,
        utmSource: attr.utm_source || null, utmMedium: attr.utm_medium || null,
        utmCampaign: attr.utm_campaign || null, utmContent: attr.utm_content || null,
        utmTerm: attr.utm_term || null,
        pageUrl: location.href, sessionId: sid, deviceType: device(),
        value: value == null ? null : value
      };
      // Ad click ids ride on EVERY visit and conversion (v2.4) — the stored ones,
      // not just this page's, so a booking made three pages deep still carries
      // the identifier of the ad click that started the journey.
      addClickIds(payload);
      if (type === "conversion") {
        var j = parse(getCookie(JKEY) || "");
        payload.journey = (j instanceof Array) ? j : journey;
        // Coupon (v2.3): live read on the page, else the stash from the form page.
        var coupon = couponForConversion();
        if (coupon) payload.couponCodeUsed = coupon;
      }
      post(JSON.stringify(payload));
      log(type, payload);
    }

    // ── Funnel stages (snippet v2.1): detect this page's stage + fire
    //    stage_reached when the session reaches a NEW highest stage. ──
    function detectStage() {
      try {
        var el = document.querySelector("[data-ht-stage]");
        if (!el) return null;
        var s = (el.getAttribute("data-ht-stage") || "").toLowerCase().trim();
        return STAGES.indexOf(s) >= 0 ? s : null;
      } catch (e) { return null; }
    }
    function sendStageReached(stage) {
      var payload = {
        siteId: siteId, type: "stage_reached", v: VERSION,
        sessionId: sid, visitorId: vid, stage: stage, timestamp: Date.now()
      };
      post(JSON.stringify(payload));
      log("stage_reached", payload);
    }
    // Fire at most once per stage per session, and only for a HIGHER stage than
    // the session's current max (going back to a lower stage does nothing).
    function maybeStageReached(stage) {
      if (!stage) return;
      var rank = STAGES.indexOf(stage) + 1;
      if (rank <= 0) return;
      var cur = parseInt(ssGet("ht_max_stage") || "0", 10);
      if (rank > cur) { ssSet("ht_max_stage", String(rank)); sendStageReached(stage); }
    }

    // ── Visitor journey (snippet v2): per-page capture within a session. ──
    var curPath = null, enteredAt = 0, lastPvPath = null, lastPvTs = 0, idleTimer = null;
    function resetIdle() {
      if (idleTimer) { try { clearTimeout(idleTimer); } catch (e) {} }
      idleTimer = setTimeout(function () { sendPageExit("inactivity_timeout"); }, IDLE_MS);
    }
    function sendPageview(path) {
      // Debounce a duplicate pageview for the same path (React StrictMode double
      // mount / rapid history ops) within 500ms.
      var now = Date.now();
      if (path === lastPvPath && (now - lastPvTs) < 500) return;
      lastPvPath = path; lastPvTs = now;
      ensureSession();
      curPath = path; enteredAt = now;
      var stage = detectStage();
      var payload = {
        siteId: siteId, type: "pageview", v: VERSION,
        sessionId: sid, visitorId: vid,
        pagePath: path, // path only — NO query string, NO hash
        pageTitle: document.title || null, referrer: document.referrer || null,
        pageUrl: location.href, timestamp: now,
        funnelStage: stage, // null when the page isn't tagged (server may URL-match)
        viewportWidth: viewportW(), viewportHeight: viewportH(),
        userAgent: navigator.userAgent || null, deviceType: device(),
        // First-touch UTM (captured once on landing) — so the derived visit row +
        // the session's landing UTM match the legacy behavior. NOT re-read per page.
        utmSource: attr.utm_source || null, utmMedium: attr.utm_medium || null,
        utmCampaign: attr.utm_campaign || null, utmContent: attr.utm_content || null,
        utmTerm: attr.utm_term || null
      };
      // Pageviews carry them too, so the Session row can be stamped with the ad
      // click that started it (a session's landing evidence, not just the event's).
      addClickIds(payload);
      post(JSON.stringify(payload));
      log("pageview", payload);
      maybeStageReached(stage);
      resetIdle();
    }
    function sendPageExit(reason) {
      if (!curPath || !enteredAt) return; // nothing open to exit
      var dur = Date.now() - enteredAt;
      var payload = {
        siteId: siteId, type: "page_exit", v: VERSION,
        sessionId: sid, visitorId: vid,
        pagePath: curPath, timeOnPageMs: dur < 0 ? 0 : dur,
        exitReason: reason, timestamp: Date.now()
      };
      post(JSON.stringify(payload));
      log("page_exit", payload);
      enteredAt = 0; // guard against a duplicate exit (navigation then unload)
    }

    // Shared SPA-navigation dispatcher: wrap history ONCE and fan out to listeners.
    // Both journey capture and conversion detection subscribe via onSpaNav().
    var navFns = [];
    function onSpaNav(fn) { navFns.push(fn); }
    function fireNav() { for (var i = 0; i < navFns.length; i++) { try { navFns[i](); } catch (e) {} } }
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (orig) history[m] = function () { var r = orig.apply(this, arguments); setTimeout(fireNav, 0); return r; };
    });
    addEventListener("popstate", function () { setTimeout(fireNav, 0); });
    addEventListener("hashchange", function () { setTimeout(fireNav, 0); });

    // Journey: on a real path change, exit the old page then view the new one.
    onSpaNav(function () {
      var p = location.pathname;
      if (p === curPath) return; // query/hash-only change — not a new page
      sendPageExit("navigation");
      sendPageview(p);
    });
    // Final exit when the tab closes / navigates away (beacon survives unload).
    addEventListener("pagehide", function () { sendPageExit("unload"); });

    // 5. First page of the load fires a pageview (replaces the v1 "visit").
    sendPageview(location.pathname);

    // 8. Read the booking value from page data only — never names, emails, or
    // form contents. Three strategies, tried in order; the first that yields a
    // positive number wins. Returns null if all fail (the conversion still fires).
    function parseAmount(raw) {
      if (raw == null) return null;
      var cleaned = String(raw).replace(/[^0-9.]/g, "");
      if (!cleaned) return null;
      var n = parseFloat(cleaned);
      return isFinite(n) && n > 0 ? n : null;
    }
    // Strategy B: scan visible page text for a booking total. Prefer a labelled
    // amount ("Total: ₹12,345", "Amount paid ₹…"); otherwise fall back to the
    // largest ₹ figure on the page (a booking total is almost always the biggest).
    function valueFromText() {
      try {
        var text = document.body ? (document.body.innerText || document.body.textContent || "") : "";
        if (!text) return null;
        var labelled = text.match(
          /(?:grand\s*total|total\s*amount|amount\s*paid|you\s*paid|booking\s*total|total|amount)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i
        );
        if (labelled) { var la = parseAmount(labelled[1]); if (la != null) return la; }
        var amounts = [], re = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g, m;
        while ((m = re.exec(text))) { var v = parseAmount(m[1]); if (v != null) amounts.push(v); }
        if (amounts.length) return Math.max.apply(null, amounts);
      } catch (e) {}
      return null;
    }
    function extractBookingValue() {
      try {
        // Strategy A — data attribute (configured selector, or [data-ht-value]).
        // Cleanest + most reliable; recommended in the install guide. If several
        // elements match (e.g. line-item subtotals plus a grand total), take the
        // LARGEST parsed amount — the booking total is almost always the biggest.
        var sel = (cfg && cfg.valueSelector) || "[data-ht-value]";
        var els = document.querySelectorAll(sel), bestA = null;
        for (var ai = 0; ai < els.length; ai++) {
          var raw = els[ai].getAttribute && els[ai].getAttribute("data-ht-value");
          if (raw == null) raw = els[ai].textContent || "";
          var a = parseAmount(raw);
          if (a != null && (bestA == null || a > bestA)) bestA = a;
        }
        if (bestA != null) return bestA;
        // Strategy B — regex over page text.
        var b = valueFromText();
        if (b != null) return b;
        // Strategy C — a thank-you URL parameter (amount/total/value/price/booking_value).
        var q = new URLSearchParams(location.search);
        var keys = ["amount", "total", "value", "price", "booking_value"];
        for (var i = 0; i < keys.length; i++) {
          var c = parseAmount(q.get(keys[i]));
          if (c != null) return c;
        }
      } catch (e) {}
      return null;
    }

    // 8b. Decouple "conversion detected" from "value extracted". On SPA sites
    // (Next.js/React) the URL changes via history.pushState BEFORE React commits
    // the /thank-you DOM, so reading the value synchronously at detection time
    // races the render and yields null. Instead, open a bounded window and
    // resolve with the value the moment it appears — a [data-ht-value]-scoped
    // MutationObserver catches React's commit, a requestAnimationFrame poll gives
    // fast resolution, and a hard setTimeout deadline is the authoritative
    // backstop (it still fires when the tab is backgrounded and rAF is paused).
    // Already-rendered pages (WordPress/Shopify/plain HTML) resolve on the first
    // synchronous check, so non-SPA sites see no added delay. Resolves null only
    // if nothing appears before the deadline — the conversion fires either way.
    var VALUE_WAIT_MS = 2000;
    function waitForBookingValue(maxWaitMs, done) {
      var settled = false, obs = null, deadline = null, start = Date.now();
      function finish(v) {
        if (settled) return;
        settled = true;
        if (obs) { try { obs.disconnect(); } catch (e) {} }
        if (deadline) { try { clearTimeout(deadline); } catch (e) {} }
        try { removeEventListener("pagehide", flush); removeEventListener("visibilitychange", onVis); } catch (e) {}
        log("value:resolved", { value: v, elapsedMs: Date.now() - start });
        done(v);
      }
      function flush() { finish(extractBookingValue()); }
      function onVis() { if (document.visibilityState === "hidden") flush(); }

      // First try: value may already be on the page (non-SPA / fast commit).
      var first = extractBookingValue();
      log("value:initial", { value: first });
      if (first != null) return finish(first);

      // Catch React's commit: watch the DOM for the value element/attribute.
      try {
        if (window.MutationObserver && document.body) {
          obs = new MutationObserver(function () {
            if (settled) return;
            var v = extractBookingValue();
            if (v != null) finish(v);
          });
          obs.observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ["data-ht-value"]
          });
        }
      } catch (e) {}

      // If the visitor leaves before the value renders, send our best effort now
      // (send() uses sendBeacon, which survives unload).
      try {
        addEventListener("pagehide", flush);
        addEventListener("visibilitychange", onVis);
      } catch (e) {}

      // Authoritative deadline — fires even if rAF is throttled in a hidden tab.
      deadline = setTimeout(function () { finish(extractBookingValue()); }, maxWaitMs);

      // Fast poll while foregrounded; resolves the instant the value appears.
      if (window.requestAnimationFrame) {
        (function tick() {
          if (settled) return;
          var v = extractBookingValue();
          if (v != null) return finish(v);
          window.requestAnimationFrame(tick);
        })();
      }
    }

    // 7. Fire a conversion at most once per session. Mark "converted" immediately
    // (so no detection path can double-fire while we wait), then resolve the
    // booking value with a bounded wait before sending the single event.
    function convert() {
      if (converted) return;
      converted = true;
      setCookie("_ht_conv", sid, null);
      if (observer) { try { observer.disconnect(); } catch (e) {} }
      log("conversion:detected", { path: location.pathname });
      waitForBookingValue(VALUE_WAIT_MS, function (value) {
        send("conversion", value);
      });
    }

    // 6. Conversion detection.
    function urlMatch(p) {
      if (!p) return false;
      if (p.indexOf("*") >= 0) {
        var rx = new RegExp(p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
        return rx.test(location.pathname) || rx.test(location.pathname + location.search);
      }
      return location.pathname.indexOf(p) >= 0 || location.href.indexOf(p) >= 0;
    }
    function checkUrl() {
      if (cfg && (cfg.method === "url_change" || cfg.method === "both") && urlMatch(cfg.thankYouUrlPattern)) convert();
    }
    function checkSame() {
      if (!cfg || (cfg.method !== "same_page" && cfg.method !== "both")) return;
      try {
        if (cfg.successSelector && document.querySelector(cfg.successSelector)) return convert();
        var txt = document.body ? (document.body.innerText || document.body.textContent || "") : "";
        if (cfg.successPhrase && txt.indexOf(cfg.successPhrase) >= 0) convert();
      } catch (e) {}
    }
    function scheduleSame() { if (pending) return; pending = true; setTimeout(function () { pending = false; checkSame(); }, 150); }

    function setup(c) {
      cfg = c;
      // url_change (and "both"): check now + watch SPA navigations. History is
      // already wrapped once at init — reuse the shared dispatcher (no double-wrap).
      if (c.method === "url_change" || c.method === "both") {
        checkUrl();
        onSpaNav(function () { setTimeout(checkUrl, 0); });
      }
      // same_page (and "both", as fallback): check now + observe the DOM.
      if (c.method === "same_page" || c.method === "both") {
        var start = function () {
          checkSame();
          if (window.MutationObserver && document.body) {
            observer = new MutationObserver(scheduleSame);
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          }
        };
        if (document.body) start(); else addEventListener("DOMContentLoaded", start);
      }
    }

    // ── Click / form-field / identity tracking (snippet v2.2) ──
    // Three additive behaviors. Click + form events use a light per-session client
    // cap (sessionStorage) that mirrors the server limits so a runaway page can't
    // flood the beacon; the server enforces the authoritative cap regardless.
    function underClientCap(key, max) {
      try {
        var n = parseInt(ssGet(key) || "0", 10) + 1;
        if (n > max) return false;
        ssSet(key, String(n));
        return true;
      } catch (e) { return true; }
    }

    // SHA-256 hex via Web Crypto (async). Used to hash PII on the client so the
    // RAW email/phone NEVER leaves the browser. Calls back with null when the
    // platform lacks crypto.subtle (e.g. an insecure-context http: page).
    function sha256Hex(strv, cb) {
      try {
        if (window.crypto && crypto.subtle && window.TextEncoder) {
          var data = new TextEncoder().encode(strv);
          crypto.subtle.digest("SHA-256", data).then(function (buf) {
            var a = new Uint8Array(buf), hex = "";
            for (var i = 0; i < a.length; i++) hex += ("0" + a[i].toString(16)).slice(-2);
            cb(hex);
          }, function () { cb(null); });
        } else { cb(null); }
      } catch (e) { cb(null); }
    }

    // Click: walk up from the clicked node (capped) for the nearest [data-ht-click].
    function closestClickTarget(node) {
      for (var i = 0; i < 25 && node && node.getAttribute; i++) {
        var v = node.getAttribute("data-ht-click");
        if (v != null && v !== "") return { el: node, target: clip(v, 100) };
        node = node.parentElement;
      }
      return null;
    }
    function onBodyClick(e) {
      try {
        var hit = closestClickTarget(e.target);
        if (!hit) return;
        if (!underClientCap("ht_click_n", 50)) return;
        ensureSession();
        var raw = (hit.el.textContent || "").replace(/\s+/g, " ").trim();
        var payload = {
          siteId: siteId, type: "click", v: VERSION,
          sessionId: sid, visitorId: vid, pagePath: location.pathname,
          clickTarget: hit.target,
          elementTag: hit.el.tagName || null,
          elementText: raw ? clip(raw, 100) : null, // truncate — PII minimization
          timestamp: Date.now()
        };
        post(JSON.stringify(payload));
        log("click", payload);
      } catch (e) {}
    }

    // Form fields: only INPUT/TEXTAREA/SELECT tagged with [data-ht-form-field].
    function fieldNameOf(node) {
      try {
        if (!node || !node.getAttribute) return null;
        var tag = node.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return null;
        var v = node.getAttribute("data-ht-form-field");
        return (v != null && v !== "") ? clip(v, 100) : null;
      } catch (e) { return null; }
    }
    function sendForm(action, name, hasValue) {
      try {
        if (!underClientCap("ht_form_n", 100)) return;
        ensureSession();
        var payload = {
          siteId: siteId, type: "form_field_" + action, v: VERSION,
          sessionId: sid, visitorId: vid, pagePath: location.pathname,
          fieldName: name, hasValue: hasValue, // value itself is NEVER captured
          timestamp: Date.now()
        };
        post(JSON.stringify(payload));
        log("form_field_" + action, payload);
      } catch (e) {}
    }
    function onFieldFocus(e) {
      var fn = fieldNameOf(e.target);
      if (fn) sendForm("focused", fn, null);
    }
    function onFieldBlur(e) {
      var el = e.target, fn = fieldNameOf(el);
      if (!fn) return;
      var has = false;
      try { has = (el.value != null ? String(el.value) : "").trim().length > 0; } catch (e2) {}
      sendForm("blurred", fn, has); // record ONLY whether it had content
    }

    // Delegated listeners on document.body (capture phase, so a stopPropagation()
    // on the page can't blind us and focus/blur — which don't bubble — are seen).
    function attachInteractionListeners() {
      var root = document.body || document;
      try {
        root.addEventListener("click", onBodyClick, true);
        root.addEventListener("focus", onFieldFocus, true);
        root.addEventListener("blur", onFieldBlur, true);
        // Coupon capture (v2.3): stash a tagged coupon field's value as it's typed.
        root.addEventListener("input", onCouponInput, true);
        root.addEventListener("change", onCouponInput, true);
      } catch (e) {}
    }
    if (document.body) attachInteractionListeners();
    else addEventListener("DOMContentLoaded", attachInteractionListeners);

    // Visitor identification. window.htIdentify({ name, email, phone, customerId }).
    // Email + phone are SHA-256-hashed in the browser before sending — the raw
    // value never reaches our backend. Name + customerId are sent as-is (names are
    // less sensitive). The (already-hashed) identity is stored in the
    // 'ht_visitor_identity' cookie so later sessions can be re-linked to it.
    var IDKEY = "ht_visitor_identity";
    function sendIdentify(idt) {
      ensureSession();
      var payload = {
        siteId: siteId, type: "identify", v: VERSION,
        sessionId: sid, visitorId: vid,
        name: idt.name || null, customerId: idt.customerId || null,
        emailHash: idt.emailHash || null, phoneHash: idt.phoneHash || null,
        timestamp: Date.now()
      };
      post(JSON.stringify(payload));
      log("identify", payload);
    }
    function storeIdentity(idt) {
      // Persist ONLY name + hashes + customerId — never raw email/phone.
      try {
        setCookie(IDKEY, JSON.stringify({
          name: idt.name || null, emailHash: idt.emailHash || null,
          phoneHash: idt.phoneHash || null, customerId: idt.customerId || null
        }), 365);
      } catch (e) {}
    }
    window.htIdentify = function (info) {
      try {
        info = info || {};
        var idt = {
          name: info.name ? clip(String(info.name), 200) : null,
          customerId: info.customerId ? clip(String(info.customerId), 200) : null,
          emailHash: null, phoneHash: null
        };
        var emailRaw = info.email ? String(info.email).trim().toLowerCase() : "";
        var phoneRaw = info.phone ? String(info.phone).replace(/[^0-9]/g, "") : "";
        var pending = 0, done = false;
        function finish() {
          if (done || pending > 0) return;
          done = true;
          storeIdentity(idt);
          sendIdentify(idt);
          ssSet("ht_identified", sid);
        }
        if (emailRaw) { pending++; sha256Hex(emailRaw, function (h) { idt.emailHash = h; pending--; finish(); }); }
        if (phoneRaw) { pending++; sha256Hex(phoneRaw, function (h) { idt.phoneHash = h; pending--; finish(); }); }
        finish(); // fires synchronously when there was nothing to hash
      } catch (e) {}
    };
    // Returning identified visitor: re-link each NEW session once (so the new
    // session's journey is attributed to the known visitor). No re-hashing needed.
    (function reidentify() {
      try {
        if (ssGet("ht_identified") === sid) return;
        var stored = parse(getCookie(IDKEY) || "");
        if (stored && (stored.name || stored.emailHash || stored.phoneHash || stored.customerId)) {
          sendIdentify(stored);
          ssSet("ht_identified", sid);
        }
      } catch (e) {}
    })();

    // ── Coupon capture (snippet v2.3) — read [data-ht-coupon-field] and STASH it
    //    so a booking's code survives the navigation from the booking form to the
    //    thank-you page (where the field no longer exists). At conversion we use a
    //    live read if the field is still on the page (same_page), else the stash. ──
    var COUPON_KEY = "ht_coupon";
    function normCoupon(v) { return v == null ? "" : String(v).trim().toUpperCase().slice(0, 50); }
    function couponValueOf(el) {
      if (!el) return "";
      var tag = el.tagName;
      var raw = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") ? el.value : (el.textContent || "");
      return normCoupon(raw);
    }
    function readCouponField() {
      try { return couponValueOf(document.querySelector("[data-ht-coupon-field]")); }
      catch (e) { return ""; }
    }
    function stashCoupon() {
      var c = readCouponField();
      if (c) ssSet(COUPON_KEY, c);
    }
    function couponForConversion() {
      var live = readCouponField();
      if (live) return live;
      return normCoupon(ssGet(COUPON_KEY));
    }
    // Stash whenever the visitor edits a tagged coupon field (capture phase).
    function onCouponInput(e) {
      try {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute("data-ht-coupon-field") != null) {
          var c = couponValueOf(t);
          if (c) ssSet(COUPON_KEY, c);
        }
      } catch (e2) {}
    }
    // Persist the code across navigation + on unload.
    onSpaNav(stashCoupon);
    addEventListener("pagehide", stashCoupon);

    // Debug aid: expose the conversion-timing internals so they can be unit-
    // tested and inspected from the console. Gated on debug mode — never exposed
    // on a normal (non-debug) production page load.
    if (DEBUG || (typeof window !== "undefined" && window.HT_DEBUG)) {
      try {
        window.__htInternals = {
          extractBookingValue: extractBookingValue,
          waitForBookingValue: waitForBookingValue,
          parseAmount: parseAmount,
          convert: convert,
          // Journey internals (v2) for tests/inspection.
          sendPageview: sendPageview,
          sendPageExit: sendPageExit,
          ensureSession: ensureSession,
          getSession: function () { return sid; },
          getVisitor: function () { return vid; },
          // Funnel internals (v2.1).
          detectStage: detectStage,
          maybeStageReached: maybeStageReached,
          // Click / form / identity internals (v2.2).
          onBodyClick: onBodyClick,
          onFieldFocus: onFieldFocus,
          onFieldBlur: onFieldBlur,
          closestClickTarget: closestClickTarget,
          fieldNameOf: fieldNameOf,
          sha256Hex: sha256Hex,
          htIdentify: window.htIdentify,
          // Coupon internals (v2.3).
          readCouponField: readCouponField,
          couponForConversion: couponForConversion,
          stashCoupon: stashCoupon,
          // Ad click ids (v2.4).
          normClickId: normClickId,
          urlClickIds: urlClickIds,
          getClickIds: clickIdPayload,
          VERSION: VERSION
        };
      } catch (e) {}
    }

    // 2. Fetch this hotel's config, then wire up conversion detection.
    fetch(base + "/api/track/config?id=" + encodeURIComponent(siteId), { mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c && !c.error) setup(c); })
      .catch(function () {});
  } catch (e) {}
})();

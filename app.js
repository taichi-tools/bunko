(function(){
  "use strict";

  var APP_VERSION = "0.11.0";
  var INDEX_VERSION = 2;          // 索引の作り方を変えたら上げる(古い索引は作り直す)
  var MAX_HITS = 1000;

  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdfjs/pdf.worker.min.js";
  // ワーカーは自分の場所を基準に読みに行くので、絶対URLで渡す
  var DOC_OPTS = {
    cMapUrl: new URL("lib/pdfjs/cmaps/", location.href).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("lib/pdfjs/standard_fonts/", location.href).href
  };
  // pdf.js は渡したバッファをワーカーへ移すので、呼び出し側では使い回さない
  function loadDoc(buf){
    var opts = Object.assign({data: new Uint8Array(buf)}, DOC_OPTS);
    return pdfjsLib.getDocument(opts).promise;
  }

  /* ---------- IndexedDB ----------
     books: 書名・最後のページなどの小さな情報(ページをめくるたびに書く)
     files: PDF本体(追加したときだけ書く)
     texts: 検索用の索引
     kv:    バックアップから読み込んだが、まだPDFがない本の情報など */
  var DB_NAME = "bunko", DB_VER = 2;   // 2: covers(表紙)を追加
  var dbPromise = null;
  function openDB(){
    if(dbPromise) return dbPromise;
    var p = dbPromise = new Promise(function(res, rej){
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function(){
        var db = r.result;
        ["books","files","texts","kv","covers"].forEach(function(n){
          if(!db.objectStoreNames.contains(n)) db.createObjectStore(n, {keyPath:"id"});
        });
      };
      r.onsuccess = function(){
        var db = r.result;
        // 新しい版が保存先の作りを変えようとしたら、こちらは身を引いて開き直す
        db.onversionchange = function(){ db.close(); if(dbPromise === p) dbPromise = null; location.reload(); };
        // 接続が切れたとき(iPhone で長く裏に回したあとなど)は、この接続を捨てる。次の保存が開き直す(0.10.3)
        db.onclose = function(){ if(dbPromise === p) dbPromise = null; };
        res(db);
      };
      r.onerror = function(){ if(dbPromise === p) dbPromise = null; rej(r.error); };
      // 古い版がホーム画面のアプリやほかのタブで開いたままだと、保存先の作りを変えられずに止まる
      r.onblocked = function(){
        shelf.innerHTML = '<div class="empty-state"><p class="big">古い版が開いたままです</p>' +
          '<p>ホーム画面のDIGITAL教材と、ほかのタブで開いているDIGITAL教材を<br>すべて閉じてから、開き直してください。</p></div>';
      };
    });
    return p;
  }
  // 失敗したら、接続だけ開き直して一度だけやり直す。書き込みは1つの transaction に全部入れているので、二重にならない。
  // 容量不足(QuotaExceededError)と、渡した値の複製の失敗(DataCloneError)は、開き直しても直らないのでやり直さない
  function tx(stores, mode, fn){
    var used = null;
    function run(){
      used = openDB();
      return used.then(function(db){
        return new Promise(function(res, rej){
          var t = db.transaction(stores, mode);
          var result;
          var r = fn(t);
          if(r) r.onsuccess = function(){ result = r.result; };
          t.oncomplete = function(){ res(result); };
          t.onerror = function(){ rej(t.error); };
          t.onabort = function(){ rej(t.error); };
        });
      });
    }
    return run().catch(function(err){
      if(err && (err.name === "QuotaExceededError" || err.name === "DataCloneError")) throw err;
      if(dbPromise === used){
        var old = dbPromise; dbPromise = null;
        old.then(function(d){ try{ d.close(); }catch(e){} }, function(){});
      }
      return openDB().then(run, function(){ throw err; });   // 開き直せなければ、元の失敗を返す
    });
  }
  // 画面に出せる保存の失敗の案内(.catch の先に置く)。続けて失敗しても、30秒に1回だけ出す
  var lastDbToast = 0;
  function dbFail(err){
    console.error(err);
    if(Date.now() - lastDbToast < 30000) return;
    lastDbToast = Date.now();
    toast(err && err.name === "QuotaExceededError"
      ? "端末に保存できませんでした(容量が足りません)"
      : "端末に保存できませんでした。アプリを閉じて開き直してください", 4500);
  }
  function dbGet(s, id){ return tx(s, "readonly", function(t){ return t.objectStore(s).get(id); }); }
  function dbAll(s){ return tx(s, "readonly", function(t){ return t.objectStore(s).getAll(); }); }
  function dbPut(s, rec){ return tx(s, "readwrite", function(t){ return t.objectStore(s).put(rec); }); }
  function dbDeleteBook(id){
    return tx(["books","files","texts","covers"], "readwrite", function(t){
      t.objectStore("books").delete(id);
      t.objectStore("files").delete(id);
      t.objectStore("texts").delete(id);
      t.objectStore("covers").delete(id);
    });
  }

  /* ---------- 小物 ---------- */
  function $(id){ return document.getElementById(id); }
  function escapeHtml(s){
    return s.replace(/[&<>"']/g, function(c){
      return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
    });
  }
  function hashIndex(str, mod){
    var h = 0;
    for(var i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) | 0; }
    return (Math.abs(h) % mod) + 1;
  }
  function toast(msg, ms){
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function(){ t.classList.remove("show"); }, ms || 2200);
  }
  function fmtMB(bytes){ return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB"; }
  function today(){
    var d = new Date();
    function p(n){ return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate());
  }

  // 捨てる canvas は大きさを0にして、メモリを早く返す(iPad の Safari は、捨てただけでは返さないことがある)
  function releaseCanvases(el){
    el.querySelectorAll("canvas").forEach(function(c){ c.width = 0; c.height = 0; });
  }

  var modalOpen = false;
  function showModal(html, wire){
    var back = $("modal-back"), sheet = $("modal-sheet");
    sheet.innerHTML = html;
    back.classList.add("active");
    modalOpen = true;
    function close(){
      back.classList.remove("active");
      back.removeEventListener("click", onBack);
      modalOpen = false;
    }
    function onBack(e){ if(e.target === back) close(); }
    back.addEventListener("click", onBack);
    if(wire) wire(sheet, close);
    return close;
  }

  /* ---------- 表示モード ---------- */
  function lsGet(k, d){ try{ var v = localStorage.getItem(k); return v === null ? d : v; }catch(e){ return d; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

  function applyTheme(pref){
    if(pref === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", pref);
    $("theme-toggle").textContent = pref === "system" ? "🌓" : (pref === "light" ? "☀️" : "🌙");
    setTimeout(function(){
      var bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-page").trim();
      if(bg) $("theme-color-meta").setAttribute("content", bg);
    }, 0);
  }
  $("theme-toggle").addEventListener("click", function(){
    var cur = lsGet("bunko-theme", "system");
    var next = cur === "system" ? "light" : (cur === "light" ? "dark" : "system");
    lsSet("bunko-theme", next);
    applyTheme(next);
  });
  applyTheme(lsGet("bunko-theme", "system"));

  /* ---------- 検索用の文字の整え方 ----------
     改行・空白を抜き、全角/半角と大文字/小文字をそろえる。
     索引・検索語・ページ上のハイライトで、すべて同じ関数を通す。 */
  var WS = /[\s​‌‍⁠﻿­]/g;
  function normStr(s){ return s.normalize("NFKC").toLowerCase().replace(WS, ""); }
  // withMap のとき、整えた後の1文字ごとに [元の文字のかたまり番号, かたまり内の位置] を持つ
  function buildNorm(items, withMap){
    var out = [], map = withMap ? [] : null;
    for(var i=0;i<items.length;i++){
      var str = items[i].str;
      if(!str) continue;
      var off = 0;
      for(var ch of str){
        var n = normStr(ch);
        for(var k=0;k<n.length;k++){
          out.push(n[k]);
          if(map) map.push(i, off, ch.length);
        }
        off += ch.length;
      }
    }
    return {text: out.join(""), map: map};
  }
  function findAll(hay, needle, limitEnd){
    var res = [], p = hay.indexOf(needle);
    while(p !== -1 && p < limitEnd){
      res.push(p);
      p = hay.indexOf(needle, p + needle.length);
    }
    return res;
  }

  /* ---------- 画面の切り替えと「戻る」 ----------
     Android の戻るボタンでアプリが閉じないよう、ビューア・検索を履歴に積む */
  function showView(name){
    $("view-library").classList.toggle("active", name === "library");
    $("view-viewer").classList.toggle("active", name === "viewer");
  }
  function pushUi(name){ try{ history.pushState({bunko: name}, ""); }catch(e){} }
  function uiBack(){
    if(history.state && history.state.bunko) history.back();
    else handleBack();
  }
  function handleBack(){
    if(modalOpen){ $("modal-back").classList.remove("active"); modalOpen = false; return; }
    if($("search-overlay").classList.contains("active")){ closeSearchOverlay(); return; }
    if($("toc-overlay").classList.contains("active")){ $("toc-overlay").classList.remove("active"); return; }
    if($("view-viewer").classList.contains("active")) closeViewer();
  }
  window.addEventListener("popstate", handleBack);

  /* ---------- 本棚 ---------- */
  var shelf = $("shelf");
  var fileInput = $("file-input");
  $("add-btn").addEventListener("click", function(){ fileInput.click(); });

  /* 表紙: 1ページ目を小さな画像にして covers に保存する(本棚を開くたびに描き直さないため) */
  var COVER_W = 360;
  var coverUrls = [];
  function makeCover(doc){
    return doc.getPage(1).then(function(page){
      var vp = page.getViewport({scale: COVER_W / page.getViewport({scale:1}).width});
      var canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      return page.render({canvasContext: canvas.getContext("2d"), viewport: vp}).promise.then(function(){
        return new Promise(function(res){ canvas.toBlob(res, "image/jpeg", 0.82); });
      });
    });
  }
  // 表紙がまだない本(表紙の機能より前に追加した本)は、本棚を開いたときに1冊ずつ作る
  var coverQueue = Promise.resolve();
  function backfillCover(b, box){
    coverQueue = coverQueue.then(function(){
      return dbGet("files", b.id).then(function(f){
        if(!f) return null;
        return loadDoc(f.data).then(function(doc){
          return makeCover(doc).then(function(blob){ doc.destroy(); return blob; }, function(err){ doc.destroy(); throw err; });
        });
      }).then(function(blob){
        if(!blob) return;
        return dbPut("covers", {id: b.id, blob: blob}).then(function(){ showCover(box, blob); });
      }).catch(function(err){ console.error(err); });
    });
  }
  function showCover(box, blob){
    var url = URL.createObjectURL(blob);
    coverUrls.push(url);
    var img = document.createElement("img");
    img.alt = "";
    img.src = url;
    box.innerHTML = "";
    box.appendChild(img);
  }
  // 書名が2行に収まらないときは、前を省略して後ろ(「テキスト2」など)を残す
  function fitTitle(el, title){
    el.textContent = title;
    if(el.scrollHeight <= el.clientHeight + 1) return;
    for(var i = 1; i < title.length; i++){
      el.textContent = "…" + title.slice(i);
      if(el.scrollHeight <= el.clientHeight + 1) return;
    }
  }

  /* 書名の頭の「27目標」: 年度が付いている本がすべて同じ年度のときだけ、表示から外す(本当の書名は変えない)。
     異なる年度が混ざったときは、どれがどの年度か分かるように、そのまま出す。
     年度が付いていない本(補助資料など)が混ざっても、年度付きの本が1種類だけなら隠したままにする。 */
  var YEAR_RE = /^[\s　]*([0-9０-９]{2})[\s　]*目標[\s　_＿\-－・]*/;
  var hiddenYear = null;
  function yearOf(title){
    var m = String(title || "").match(YEAR_RE);
    return m ? m[1].normalize("NFKC") : null;
  }
  function computeHiddenYear(books){
    var found = null;
    for(var i = 0; i < books.length; i++){
      var y = yearOf(books[i].title);
      if(!y) continue;
      if(!found) found = y;
      else if(found !== y) return null;
    }
    return found;
  }
  function updateHiddenYear(books){
    hiddenYear = computeHiddenYear(books);
  }
  function displayTitle(title, hy){
    var y = hy !== undefined ? hy : hiddenYear;
    if(!y) return title;
    var rest = title.replace(YEAR_RE, "");
    return rest || title;
  }
  function bookDisplayTitle(b, hy){
    if(b && typeof b.displayName === "string" && b.displayName.trim()) return b.displayName.trim();
    return displayTitle((b && b.title) || "", hy);
  }

  /* 本棚の表示: 最近読んだ順 / 科目ごと(右上のボタンで切り替え、端末ごとに覚える) */
  // 見出しを並べる順
  var SUBJECTS = ["財務会計論(理論)", "財務会計論(計算)", "財務会計論", "管理会計論", "監査論", "企業法", "租税法", "経営学"];
  // 書名から科目を決める順。別の科目の言葉を含みやすいものを先に見る
  // (監査論の「財務諸表監査」、経営学の「経営財務」、管理会計論の「経営意思決定」など)
  var SUBJECT_RULES = [
    ["監査論", /監査/],
    ["管理会計論", /管理会計|原価/],
    ["経営学", /経営/],
    ["租税法", /租税|税法|法人税|所得税|消費税/],
    ["企業法", /企業法|会社法|商法|金融商品取引法|金商法/],
    // 財務会計論は理論と計算に分ける。どちらの言葉もない書名は「財務会計論」にまとめる
    ["財務会計論(理論)", /(財務|財表).*理論|理論.*(財務|財表)/],
    ["財務会計論(計算)", /簿記|(財務|財表).*計算|計算.*(財務|財表)/],
    ["財務会計論", /財務|財表/]
  ];
  function subjectOf(title){
    var t = String(title || "").normalize("NFKC");
    for(var i = 0; i < SUBJECT_RULES.length; i++){ if(SUBJECT_RULES[i][1].test(t)) return SUBJECT_RULES[i][0]; }
    return "その他";
  }
  function bookSubject(b){
    if(b && typeof b.subject === "string" && b.subject.trim()) return b.subject.trim();
    return subjectOf((b && b.title) || "");
  }
  function collectCustomSubjects(books){
    var map = {};
    (books || []).forEach(function(b){
      var s = b && typeof b.subject === "string" ? b.subject.trim() : "";
      if(s && s !== "その他" && SUBJECTS.indexOf(s) === -1) map[s] = true;
    });
    return Object.keys(map).sort(function(a, b){
      return a.normalize("NFKC").localeCompare(b.normalize("NFKC"), "ja", {numeric: true});
    });
  }
  function orderedSubjects(books){
    return SUBJECTS.concat(collectCustomSubjects(books)).concat(["その他"]);
  }

  /* タグ: 正規化・集計・複数AND絞り込み */
  function normalizeTag(raw){
    return String(raw == null ? "" : raw).trim().replace(/^[#＃]+/, "").trim();
  }
  function normalizeTags(list){
    if(!Array.isArray(list)) return [];
    var out = [], seen = {};
    list.forEach(function(raw){
      var t = normalizeTag(raw);
      if(!t) return;
      var k = normStr(t);
      if(!k || seen[k]) return;
      seen[k] = true;
      out.push(t);
    });
    return out;
  }
  function collectTags(books){
    var map = {};
    (books || []).forEach(function(b){
      normalizeTags(b && b.tags).forEach(function(t){
        var k = normStr(t);
        if(!map[k]) map[k] = {name: t, count: 0};
        map[k].count++;
      });
    });
    return Object.keys(map).map(function(k){ return map[k]; }).sort(function(a, b){
      return a.name.normalize("NFKC").localeCompare(b.name.normalize("NFKC"), "ja", {numeric: true});
    });
  }
  function filterBooksByTags(books, selectedTags){
    var sel = normalizeTags(selectedTags);
    if(!sel.length) return (books || []).slice();
    var keys = sel.map(normStr);
    return (books || []).filter(function(b){
      var bKeys = {};
      normalizeTags(b && b.tags).forEach(function(t){ bKeys[normStr(t)] = true; });
      return keys.every(function(k){ return !!bKeys[k]; });
    });
  }

  var activeTags = [];
  function pruneActiveTags(books){
    if(!activeTags.length) return;
    var avail = {};
    collectTags(books).forEach(function(t){ avail[normStr(t.name)] = true; });
    activeTags = activeTags.filter(function(t){ return !!avail[normStr(t)]; });
  }
  function renderFilterBar(){
    var btn = $("filter-btn");
    var bar = $("filter-bar");
    if(btn) btn.classList.toggle("active", activeTags.length > 0);
    if(!bar) return;
    bar.innerHTML = "";
    if(!activeTags.length){ bar.hidden = true; return; }
    bar.hidden = false;
    activeTags.forEach(function(t){
      var pill = document.createElement("button");
      pill.type = "button";
      pill.className = "filter-pill";
      pill.textContent = "#" + t + " ×";
      pill.title = "タップして絞り込みを外す";
      pill.addEventListener("click", function(){
        var k = normStr(t);
        activeTags = activeTags.filter(function(x){ return normStr(x) !== k; });
        renderShelf();
      });
      bar.appendChild(pill);
    });
    var clr = document.createElement("button");
    clr.type = "button";
    clr.className = "filter-clear";
    clr.textContent = "すべて解除";
    clr.addEventListener("click", function(){
      activeTags = [];
      renderShelf();
    });
    bar.appendChild(clr);
  }
  $("filter-btn").addEventListener("click", openFilterSheet);

  var shelfMode = lsGet("bunko-shelf-mode", "recent");
  function updateModeBtn(){
    var b = $("mode-btn");
    b.textContent = shelfMode === "subject" ? "🕘" : "🗂";
    b.title = shelfMode === "subject" ? "最近読んだ順にする" : "科目ごとにする";
  }
  $("mode-btn").addEventListener("click", function(){
    shelfMode = shelfMode === "subject" ? "recent" : "subject";
    lsSet("bunko-shelf-mode", shelfMode);
    updateModeBtn();
    renderShelf();
  });
  updateModeBtn();

  function renderShelf(){
    return Promise.all([dbAll("books"), dbAll("covers")]).then(function(r){
      var books = r[0];
      updateHiddenYear(books);
      pruneActiveTags(books);
      renderFilterBar();
      var covers = {};
      r[1].forEach(function(c){ covers[c.id] = c.blob; });
      // 最近読んだ順(まだ開いていない本は、追加した順でその後ろ)
      books.sort(function(a,b){ return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || b.addedAt - a.addedAt; });
      coverUrls.forEach(function(u){ URL.revokeObjectURL(u); });
      coverUrls = [];
      shelf.innerHTML = "";
      if(books.length === 0){
        var e = document.createElement("div");
        e.className = "empty-state";
        e.innerHTML = '<p class="big">まだテキストがありません</p><p>右上の「＋」からPDFを追加してください</p>';
        shelf.appendChild(e);
        return;
      }
      var shown = filterBooksByTags(books, activeTags);
      if(shown.length === 0){
        var e2 = document.createElement("div");
        e2.className = "empty-state";
        e2.innerHTML = '<p class="big">該当するテキストがありません</p><p>選択中のタグすべてに一致する教材はありません</p>' +
          '<p style="margin-top:14px;"><button type="button" class="modal-btn plain" id="empty-clear-filter" style="flex:none;padding:10px 18px;">絞り込みを解除</button></p>';
        shelf.appendChild(e2);
        e2.querySelector("#empty-clear-filter").addEventListener("click", function(){
          activeTags = [];
          renderShelf();
        });
        return;
      }
      var titles = [];
      function addBook(b){
        var el = document.createElement("div");
        el.className = "book";
        var pct = (b.numPages && b.lastPage) ? Math.min(100, Math.round((b.lastPage / b.numPages) * 100)) : 0;
        var label = !b.numPages ? "読み込み失敗" : (b.lastOpenedAt ? "p." + b.lastPage + " / " + b.numPages : "全" + b.numPages + "ページ");
        el.innerHTML =
          '<div class="cover" style="background:var(--spine-' + (b.color || 1) + ')"></div>' +
          '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
          '<div class="book-title"></div>' +
          '<div class="book-meta">' + label + '</div>';
        var box = el.querySelector(".cover");
        if(covers[b.id]) showCover(box, covers[b.id]);
        else if(b.numPages) backfillCover(b, box);
        titles.push([el.querySelector(".book-title"), bookDisplayTitle(b)]);
        var pressTimer = null, longPressed = false;
        function startPress(){
          longPressed = false;
          pressTimer = setTimeout(function(){ longPressed = true; openBookEditSheet(b.id); }, 500);
        }
        function cancelPress(){ clearTimeout(pressTimer); }
        el.addEventListener("touchstart", startPress, {passive:true});
        el.addEventListener("touchend", cancelPress);
        el.addEventListener("touchmove", cancelPress);
        el.addEventListener("mousedown", startPress);
        el.addEventListener("mouseup", cancelPress);
        el.addEventListener("mouseleave", cancelPress);
        el.addEventListener("contextmenu", function(e){ e.preventDefault(); });
        el.addEventListener("click", function(){ if(!longPressed) openBook(b.id); });
        shelf.appendChild(el);
      }
      if(shelfMode === "subject"){
        // 科目ごと: 科目の見出しの下に、表示名の順(テキスト1 → テキスト2 → 問題集)で並べる
        var groups = {};
        shown.forEach(function(b){ var s = bookSubject(b); (groups[s] = groups[s] || []).push(b); });
        orderedSubjects(books).forEach(function(name){
          var list = groups[name];
          if(!list) return;
          list.sort(function(a, b){ return bookDisplayTitle(a).normalize("NFKC").localeCompare(bookDisplayTitle(b).normalize("NFKC"), "ja", {numeric: true}); });
          var h = document.createElement("div");
          h.className = "shelf-head";
          h.innerHTML = escapeHtml(name) + '<span>' + list.length + '冊</span>';
          shelf.appendChild(h);
          list.forEach(addBook);
        });
      } else {
        shown.forEach(addBook);
      }
      titles.forEach(function(x){ fitTitle(x[0], x[1]); });
    });
  }

  function openFilterSheet(){
    dbAll("books").then(function(books){
      pruneActiveTags(books);
      var tags = collectTags(books);
      if(!tags.length){
        showModal(
          '<h2>タグで絞り込む</h2>' +
          '<p class="note">まだタグが付いている教材はありません。本棚の長押し、または表示中のタイトルをタップしてタグを付けられます。</p>' +
          '<button type="button" class="modal-btn plain" id="fs-close" style="width:100%;">閉じる</button>',
          function(sheet, close){
            sheet.querySelector("#fs-close").addEventListener("click", close);
          }
        );
        return;
      }
      function isSelected(name){
        var k = normStr(name);
        return activeTags.some(function(t){ return normStr(t) === k; });
      }
      var chipsHtml = tags.map(function(t){
        return '<button type="button" class="tag-chip' + (isSelected(t.name) ? ' active' : '') + '" data-tag="' + escapeHtml(t.name) + '">' +
          '#' + escapeHtml(t.name) + '<span>' + t.count + '</span></button>';
      }).join("");
      showModal(
        '<h2>タグで絞り込む（すべて含む）</h2>' +
        '<p class="note" id="fs-summary"></p>' +
        '<div class="tag-chips" id="fs-chips">' + chipsHtml + '</div>' +
        '<div class="modal-row">' +
        '<button type="button" class="modal-btn plain" id="fs-clear">すべて解除</button>' +
        '<button type="button" class="modal-btn primary" id="fs-close">閉じる</button>' +
        '</div>',
        function(sheet, close){
          var summary = sheet.querySelector("#fs-summary");
          var clearBtn = sheet.querySelector("#fs-clear");
          var chips = sheet.querySelectorAll(".tag-chip");
          function sync(){
            var matched = filterBooksByTags(books, activeTags).length;
            summary.textContent = activeTags.length
              ? "選択中の " + activeTags.length + "件に一致: " + matched + " / " + books.length + "冊"
              : "全 " + books.length + "冊を表示中（複数選ぶとすべて含む教材に絞り込めます）";
            clearBtn.disabled = activeTags.length === 0;
            chips.forEach(function(ch){
              ch.classList.toggle("active", isSelected(ch.dataset.tag));
            });
          }
          chips.forEach(function(ch){
            ch.addEventListener("click", function(){
              var tag = ch.dataset.tag;
              var k = normStr(tag);
              if(isSelected(tag)) activeTags = activeTags.filter(function(t){ return normStr(t) !== k; });
              else activeTags = activeTags.concat([tag]);
              sync();
              renderShelf();
            });
          });
          clearBtn.addEventListener("click", function(){
            activeTags = [];
            sync();
            renderShelf();
          });
          sheet.querySelector("#fs-close").addEventListener("click", close);
          sync();
        }
      );
    }).catch(dbFail);
  }

  function openBookEditSheet(bookId, opts){
    dbAll("books").then(function(allBooks){
      var b = allBooks.filter(function(x){ return x.id === bookId; })[0];
      if(!b) return;
      updateHiddenYear(allBooks);
      var defaultShown = displayTitle(b.title);
      var initialName = (typeof b.displayName === "string" && b.displayName.trim()) ? b.displayName.trim() : defaultShown;
      var autoSub = subjectOf(b.title);
      var curSub = (typeof b.subject === "string" && b.subject.trim()) ? b.subject.trim() : "";
      var subOptions = '<option value="">自動（判定: ' + escapeHtml(autoSub) + '）</option>' +
        orderedSubjects(allBooks).map(function(s){
          return '<option value="' + escapeHtml(s) + '"' + (curSub === s ? ' selected' : '') + '>' + escapeHtml(s) + '</option>';
        }).join("") +
        '<option value="__new__">＋ 新しい科目を追加…</option>';
      var allKnownTags = collectTags(allBooks).map(function(t){ return t.name; });
      var selectedMap = {};
      normalizeTags(b.tags).forEach(function(t){ selectedMap[normStr(t)] = t; });

      showModal(
        '<h2>本の編集</h2>' +
        '<div class="field-label"><span>表示名</span><button type="button" class="link-btn" id="be-reset-name">元の名前に戻す</button></div>' +
        '<input type="text" id="be-name" value="' + escapeHtml(initialName) + '">' +
        '<p class="field-hint">元のファイル名: ' + escapeHtml(b.title) + '</p>' +
        '<div class="field-label"><span>科目</span></div>' +
        '<select class="modal-select" id="be-subject">' + subOptions + '</select>' +
        '<input type="text" id="be-subject-new" placeholder="新しい科目名を入力" style="display:none;">' +
        '<div class="field-label"><span>タグ</span></div>' +
        '<div class="tag-chips" id="be-tags"></div>' +
        '<div class="tag-add-row">' +
        '<input type="text" id="be-tag-input" placeholder="新しいタグを追加">' +
        '<button type="button" class="modal-btn plain" id="be-tag-add">追加</button>' +
        '</div>' +
        '<div class="modal-row">' +
        '<button type="button" class="modal-btn plain" id="be-cancel">キャンセル</button>' +
        '<button type="button" class="modal-btn primary" id="be-save">保存</button>' +
        '</div>' +
        '<div class="sheet-danger-zone">' +
        '<button type="button" class="modal-btn danger-outline" id="be-delete">このテキストを削除</button>' +
        '</div>',
        function(sheet, close){
          var nameInput = sheet.querySelector("#be-name");
          var resetBtn = sheet.querySelector("#be-reset-name");
          var subSelect = sheet.querySelector("#be-subject");
          var subNew = sheet.querySelector("#be-subject-new");
          var tagsBox = sheet.querySelector("#be-tags");
          var tagInput = sheet.querySelector("#be-tag-input");
          var tagAddBtn = sheet.querySelector("#be-tag-add");
          var resetName = false;

          nameInput.addEventListener("input", function(){ resetName = false; });
          resetBtn.addEventListener("click", function(){
            nameInput.value = defaultShown;
            resetName = true;
          });
          subSelect.addEventListener("change", function(){
            var isNew = subSelect.value === "__new__";
            subNew.style.display = isNew ? "" : "none";
            if(isNew) subNew.focus();
          });

          function renderTagChips(){
            tagsBox.innerHTML = "";
            allKnownTags.forEach(function(t){
              var k = normStr(t);
              var btn = document.createElement("button");
              btn.type = "button";
              btn.className = "tag-chip" + (selectedMap[k] ? " active" : "");
              btn.textContent = "#" + t;
              btn.addEventListener("click", function(){
                if(selectedMap[k]) delete selectedMap[k];
                else selectedMap[k] = t;
                renderTagChips();
              });
              tagsBox.appendChild(btn);
            });
          }
          function addInputTag(){
            var t = normalizeTag(tagInput.value);
            if(!t) return;
            var k = normStr(t);
            var existing = allKnownTags.filter(function(x){ return normStr(x) === k; })[0];
            if(!existing){
              allKnownTags.push(t);
              existing = t;
            }
            selectedMap[k] = existing;
            tagInput.value = "";
            renderTagChips();
          }
          renderTagChips();
          tagAddBtn.addEventListener("click", addInputTag);
          tagInput.addEventListener("keydown", function(e){
            if(e.key === "Enter" && !(e.isComposing || e.keyCode === 229)){
              e.preventDefault();
              addInputTag();
            }
          });

          sheet.querySelector("#be-cancel").addEventListener("click", close);
          sheet.querySelector("#be-save").addEventListener("click", function(){
            var subVal = subSelect.value;
            if(subVal === "__new__"){
              subVal = subNew.value.trim();
              if(!subVal){
                toast("新しい科目名を入力してください");
                subNew.focus();
                return;
              }
            }
            addInputTag();
            var finalTags = normalizeTags(Object.keys(selectedMap).map(function(k){ return selectedMap[k]; }));
            var v = nameInput.value.trim();
            var clearName = !v || resetName || (!b.displayName && v === defaultShown);
            dbGet("books", b.id).then(function(rec){
              if(!rec) return;
              if(clearName) delete rec.displayName;
              else rec.displayName = v;
              if(!subVal) delete rec.subject;
              else rec.subject = subVal;
              if(finalTags.length) rec.tags = finalTags;
              else delete rec.tags;
              return dbPut("books", rec).then(function(){
                if(currentBook && currentBook.id === rec.id){
                  if(rec.displayName) currentBook.displayName = rec.displayName; else delete currentBook.displayName;
                  if(rec.subject) currentBook.subject = rec.subject; else delete currentBook.subject;
                  if(rec.tags) currentBook.tags = rec.tags; else delete currentBook.tags;
                  $("viewer-title").textContent = bookDisplayTitle(currentBook);
                }
              });
            }).then(function(){
              close();
              renderShelf();
              toast("保存しました");
            }).catch(dbFail);
          });
          sheet.querySelector("#be-delete").addEventListener("click", function(){
            close();
            openDeleteConfirm(b, opts);
          });
        }
      );
    }).catch(dbFail);
  }
  function openDeleteConfirm(b, opts){
    showModal(
      '<h2>「' + escapeHtml(bookDisplayTitle(b)) + '」を削除しますか？</h2>' +
      '<p class="note">この操作は取り消せません。</p>' +
      '<div class="modal-row">' +
      '<button type="button" class="modal-btn plain" id="ms-cancel">キャンセル</button>' +
      '<button type="button" class="modal-btn danger" id="ms-del">削除する</button>' +
      '</div>',
      function(sheet, close){
        sheet.querySelector("#ms-cancel").addEventListener("click", close);
        sheet.querySelector("#ms-del").addEventListener("click", function(){
          dbDeleteBook(b.id).then(function(){
            close();
            if(currentBook && currentBook.id === b.id){
              clearTimeout(saveTimer); saveTimer = null;
              currentBook = null;
              if(opts && opts.fromViewer) uiBack();
              else closeViewer();
            } else {
              renderShelf();
            }
            toast("削除しました");
          }).catch(function(err){ console.error(err); toast("削除できませんでした。アプリを閉じて開き直してください", 4500); });
        });
      }
    );
  }

  fileInput.addEventListener("change", function(){
    var files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = "";
    addFiles(files);
  });
  // PDFを本棚に足す。1冊だけのときは、足したあと(すでにあればその本を)開く(open が true のとき)
  var lastBookId = null;
  function addFiles(files, open){
    if(files.length === 0) return Promise.resolve();
    lastBookId = null;
    toast("追加しています…", 60000);
    var added = 0, skipped = 0, failed = 0;
    var chain = Promise.resolve();
    files.forEach(function(f){
      chain = chain.then(function(){
        return addBookFromFile(f).then(function(r){
          if(r === "added") added++; else if(r === "dup") skipped++; else failed++;
        });
      });
    });
    return chain.then(renderShelf).then(function(){
      var msg = [];
      if(added) msg.push(added + "冊を追加しました");
      if(skipped) msg.push(skipped + "冊はすでに本棚にあります");
      if(failed) msg.push(failed + "冊は追加できませんでした");
      toast(msg.join("／"), 3500);
      if(added) requestPersist();
      if(open && files.length === 1 && lastBookId) openBook(lastBookId);
      return failed;
    });
  }

  function addBookFromFile(file){
    var buf, meta;
    return file.arrayBuffer().then(function(b){
      buf = b;
      return loadDoc(buf.slice(0));
    }).then(function(doc){
      var fp = (doc.fingerprints && doc.fingerprints[0]) || null;
      var numPages = doc.numPages;
      var cover = null;
      return makeCover(doc).catch(function(err){ console.error(err); return null; }).then(function(blob){
        cover = blob;
        doc.destroy();
        return dbAll("books");
      }).then(function(books){
        var same = fp ? books.filter(function(x){ return x.fingerprint === fp; })[0] : null;
        if(same){ lastBookId = same.id; return "dup"; }
        var title = file.name.replace(/\.pdf$/i, "");
        meta = {
          id: "b_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
          title: title, addedAt: Date.now(), lastOpenedAt: 0,
          lastPage: 1, numPages: numPages, fingerprint: fp,
          size: buf.byteLength, color: hashIndex(title, 6)
        };
        return applyPending(meta).then(function(){
          return tx(["books","files","covers"], "readwrite", function(t){
            t.objectStore("files").put({id: meta.id, data: buf});
            t.objectStore("books").put(meta);
            if(cover) t.objectStore("covers").put({id: meta.id, blob: cover});
          });
        }).then(function(){ lastBookId = meta.id; return "added"; });
      });
    }).catch(function(err){
      console.error(err);
      if(err && err.name === "QuotaExceededError") toast("保存容量が足りません", 4000);
      return "failed";
    });
  }

  function requestPersist(){
    if(navigator.storage && navigator.storage.persist){
      navigator.storage.persisted().then(function(p){
        if(!p) return navigator.storage.persist();
      }).catch(function(){});
    }
  }

  /* ---------- ビューア ---------- */
  var currentBook = null, currentDoc = null, currentIndex = null, indexPromise = null;
  var pageAnchor = 1;
  var spread = lsGet("bunko-spread", "0") === "1";
  var pageWrap = $("page-wrap"), pageArea = $("page-area");
  var pageSlider = $("page-slider"), pageIndicator = $("page-indicator");
  var viewerHeader = $("viewer-header"), viewerFooter = $("viewer-footer");
  var spreadBtn = $("spread-btn");
  spreadBtn.classList.toggle("active", spread);

  // 検索の状態
  var activeQuery = "", activeLabel = "", hits = [], hitCursor = -1;

  function openBook(id){
    Promise.all([dbGet("books", id), dbGet("files", id), dbGet("texts", id)]).then(function(r){
      var meta = r[0], file = r[1], texts = r[2];
      if(!meta) return;
      currentBook = meta;
      currentBook.lastOpenedAt = Date.now();
      // 開けなかったときも、閉じるときに別の本のページ番号で上書きしないよう、この本の位置で初期化する
      pageAnchor = Math.min(Math.max(1, meta.lastPage || 1), meta.numPages || 1);
      currentIndex = (texts && texts.v === INDEX_VERSION) ? texts.pages : null;
      indexPromise = null;
      outlinePromise = null;
      clearHits();
      $("viewer-title").textContent = bookDisplayTitle(meta);
      showView("viewer");
      pushUi("viewer");
      pageWrap.classList.remove("show");
      releaseCanvases(pageWrap);
      pageWrap.innerHTML = '<div class="load-msg">開いています…</div>';
      pageWrap.classList.add("show");
      if(!file || !meta.numPages){
        pageWrap.innerHTML = '<div class="load-msg">このPDFを開けませんでした。<br>ファイルが壊れているか、非対応の形式です。</div>';
        return;
      }
      loadDoc(file.data).then(function(doc){
        if(currentBook !== meta){ doc.destroy(); return; }
        currentDoc = doc;
        pageAnchor = Math.min(Math.max(1, meta.lastPage || 1), doc.numPages);
        if(spread) pageAnchor = spreadAnchor(pageAnchor);
        resetZoom();
        renderPages();
      }).catch(function(err){
        console.error(err);
        pageWrap.innerHTML = '<div class="load-msg">読み込み中にエラーが発生しました。</div>';
      });
    });
  }

  function closeViewer(){
    setSelectMode(false);
    clearTimeout(saveTimer); saveTimer = null;
    if(currentBook){ currentBook.lastPage = pageAnchor; dbPut("books", currentBook).catch(dbFail); }
    cancelRenders();
    // 高精細の描き直しが、閉じたあとに破棄済みの本へ走らないよう止める
    clearTimeout(detailTimer);
    detailTasks.forEach(function(t){ try{ t.cancel(); }catch(e){} });
    detailTasks = [];
    renderInfo = null; gesture = null;
    if(currentDoc){ currentDoc.destroy(); currentDoc = null; }
    currentBook = null; currentIndex = null; indexPromise = null; outlinePromise = null;
    clearHits();
    setUiHidden(false);
    showView("library");
    renderShelf();
  }
  $("back-btn").addEventListener("click", uiBack);
  $("viewer-title").addEventListener("click", function(){
    if(currentBook) openBookEditSheet(currentBook.id, {fromViewer: true});
  });

  // 見開きは 1 / 2-3 / 4-5 … の組
  function spreadAnchor(p){ return (p <= 1) ? 1 : (p % 2 === 0 ? p : p - 1); }
  function pagesShown(anchor, numPages){
    if(!spread || anchor <= 1) return [anchor];
    var arr = [anchor];
    if(anchor + 1 <= numPages) arr.push(anchor + 1);
    return arr;
  }

  var renderSeq = 0, runningTasks = [];
  function cancelRenders(){
    runningTasks.forEach(function(t){ try{ t.cancel(); }catch(e){} });
    runningTasks = [];
  }

  function renderPages(){
    if(!currentDoc) return;
    var seq = ++renderSeq;
    cancelRenders();
    var doc = currentDoc;
    var numPages = doc.numPages;
    var pages = pagesShown(pageAnchor, numPages);
    // 余白は付けず、画面いっぱいまで使う
    var containerW = pageArea.clientWidth;
    var containerH = pageArea.clientHeight;
    var count = pages.length, gap = 2;   // 見開きの2ページの間の線の太さ(index.html の .page-wrap の gap と同じにする)
    var dpr = window.devicePixelRatio || 1;
    var z = zoom;
    // 選択モードで選んでいる範囲は、描き直したあとに選び直す
    var restoreSel = null;
    if(selectMode){ restoreSel = pendingSel || saveSelection(); pendingSel = null; }
    var textJobs = [];

    if(!sliderDrag || !sliderDrag.active) sliderSet(pageAnchor, numPages);
    pageIndicator.textContent = (pages.length === 2 ? pages[0] + "–" + pages[1] : pageAnchor) + " / " + numPages;
    saveProgress();

    Promise.all(pages.map(function(p){ return doc.getPage(p); })).then(function(pageObjs){
      if(seq !== renderSeq) return;
      var baseVp = pageObjs[0].getViewport({scale:1});
      var widthBudget = (containerW - gap * (count - 1)) / count;
      var fit = Math.min(widthBudget / baseVp.width, containerH / baseVp.height);
      var scale = fit * z;
      fitW = count * baseVp.width * fit + gap * (count - 1);
      fitH = baseVp.height * fit;

      var frag = document.createDocumentFragment();
      var boxes = [], minD = dpr;
      var jobs = pageObjs.map(function(page, i){
        var viewport = page.getViewport({scale: scale});
        var box = document.createElement("div");
        box.className = "pg";
        box.dataset.page = pages[i];
        box.style.width = Math.floor(viewport.width) + "px";
        box.style.height = Math.floor(viewport.height) + "px";
        // 大きく拡大したときは、端末のメモリに収まるよう解像度を抑える
        var d = Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / count / (viewport.width * viewport.height)));
        minD = Math.min(minD, d);
        boxes.push(box);
        var canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * d);
        canvas.height = Math.floor(viewport.height * d);
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";
        var layer = document.createElement("div");
        layer.className = "hl-layer";
        box.appendChild(canvas);
        box.appendChild(layer);
        frag.appendChild(box);
        var task = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport: viewport,
          transform: d !== 1 ? [d,0,0,d,0,0] : null
        });
        runningTasks.push(task);
        if(activeQuery) drawHighlights(page, pages[i], viewport, layer, seq);
        if(selectMode) textJobs.push(addTextLayer(page, viewport, box));
        return task.promise;
      });

      Promise.all(jobs).then(function(){
        if(seq !== renderSeq) return;
        pageWrap.classList.remove("show");
        releaseCanvases(pageWrap);
        pageWrap.innerHTML = "";
        pageWrap.appendChild(frag);
        pageWrap.classList.add("show");
        renderedZoom = z;
        clampPan();
        applyTransform();
        renderInfo = {seq: seq, pages: pageObjs, scale: scale, boxes: boxes, dLow: minD < dpr * 0.99, dpr: dpr};
        scheduleDetail();
        if(restoreSel){
          Promise.all(textJobs).then(function(){
            if(seq === renderSeq && selectMode) restoreSelection(restoreSel);
          });
        }
      }).catch(function(err){
        if(err && err.name === "RenderingCancelledException") return;
        console.error(err);
      });
    }).catch(function(err){
      if(seq !== renderSeq) return;
      console.error(err);
      pageWrap.innerHTML = '<div class="load-msg">このページを読み込めませんでした。</div>';
      pageWrap.classList.add("show");
    });
  }

  /* 見えている部分だけを高い解像度で重ねて描く
     ページ全体の画像は、画素数の上限(iPad の Safari は超えると真っ白になる)のため、
     大きく拡大すると解像度を下げて描いている。止まったあとで、画面に見えている範囲だけを
     画面の細かさいっぱいで描き、ページ画像と印(ハイライト)の間に重ねる。 */
  var renderInfo = null, detailTimer = null, detailSeq = 0, detailTasks = [];
  function scheduleDetail(){
    clearTimeout(detailTimer);
    detailTimer = setTimeout(renderDetail, 200);
  }
  function renderDetail(){
    var info = renderInfo;
    if(!info || info.seq !== renderSeq || !info.dLow) return;
    if(gesture || zoom !== renderedZoom){ scheduleDetail(); return; }
    var my = ++detailSeq;
    detailTasks.forEach(function(t){ try{ t.cancel(); }catch(e){} });
    detailTasks = [];
    var ar = pageArea.getBoundingClientRect();
    var dpr = info.dpr;
    info.boxes.forEach(function(box, i){
      var br = box.getBoundingClientRect();
      var x1 = Math.max(br.left, ar.left), y1 = Math.max(br.top, ar.top);
      var x2 = Math.min(br.right, ar.right), y2 = Math.min(br.bottom, ar.bottom);
      var old = box.querySelector("canvas.detail");
      if(x2 - x1 < 1 || y2 - y1 < 1){ if(old) old.remove(); return; }
      // ページの中での、見えている範囲(CSS の px)
      var vx = Math.floor(x1 - br.left), vy = Math.floor(y1 - br.top);
      var vw = Math.ceil(x2 - br.left) - vx, vh = Math.ceil(y2 - br.top) - vy;
      var c = document.createElement("canvas");
      c.className = "detail";
      c.width = Math.floor(vw * dpr);
      c.height = Math.floor(vh * dpr);
      c.style.left = vx + "px"; c.style.top = vy + "px";
      c.style.width = vw + "px"; c.style.height = vh + "px";
      var task = info.pages[i].render({
        canvasContext: c.getContext("2d"),
        viewport: info.pages[i].getViewport({scale: info.scale}),
        transform: [dpr, 0, 0, dpr, -vx * dpr, -vy * dpr]
      });
      detailTasks.push(task);
      task.promise.then(function(){
        if(my !== detailSeq || info.seq !== renderSeq) return;
        var prev = box.querySelector("canvas.detail");
        if(prev){ prev.width = 0; prev.height = 0; prev.remove(); }
        box.insertBefore(c, box.querySelector(".hl-layer"));
      }).catch(function(err){
        if(err && err.name === "RenderingCancelledException") return;
        console.error(err);
      });
    });
  }

  var saveTimer = null;
  function saveProgress(){
    if(!currentBook) return;
    currentBook.lastPage = pageAnchor;
    var rec = currentBook;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){ dbPut("books", rec).catch(dbFail); }, 400);
  }

  function goTo(p){
    if(!currentDoc) return;
    p = Math.min(Math.max(1, p), currentDoc.numPages);
    pageAnchor = spread ? spreadAnchor(p) : p;
    resetZoom();
    renderPages();
  }
  function goNext(){
    if(!currentDoc) return;
    var n = currentDoc.numPages;
    if(!spread) goTo(pageAnchor + 1);
    else goTo(pageAnchor === 1 ? 2 : Math.min(n, pageAnchor + 2));
  }
  function goPrev(){
    if(!currentDoc) return;
    if(!spread) goTo(pageAnchor - 1);
    else goTo(pageAnchor <= 2 ? 1 : pageAnchor - 2);
  }
  $("nav-next").addEventListener("click", goNext);
  $("nav-prev").addEventListener("click", goPrev);
  document.addEventListener("keydown", function(e){
    if(!$("view-viewer").classList.contains("active") || $("search-overlay").classList.contains("active") || $("toc-overlay").classList.contains("active")) return;
    if(e.key === "ArrowRight" || e.key === "PageDown") goNext();
    else if(e.key === "ArrowLeft" || e.key === "PageUp") goPrev();
  });

  spreadBtn.addEventListener("click", function(){
    spread = !spread;
    lsSet("bunko-spread", spread ? "1" : "0");
    spreadBtn.classList.toggle("active", spread);
    goTo(pageAnchor);
  });

  /* ページのスライダー
     触れただけでは動かさず、指が横に動いたときだけページを動かす。
     Android のジェスチャー(下の端から上へスワイプしてホームへ)で、ページが飛ばないようにするため。 */
  var sliderThumb = $("slider-thumb"), sliderFill = $("slider-fill");
  var sliderDrag = null, sliderRenderTimer = null;
  function sliderSet(p, max){
    var r = max > 1 ? (p - 1) / (max - 1) : 0;
    sliderFill.style.width = (r * 100) + "%";
    sliderThumb.style.left = "calc(10px + (100% - 20px) * " + r + ")";
  }
  function sliderPageAt(x){
    var rect = pageSlider.getBoundingClientRect();
    var r = Math.min(1, Math.max(0, (x - rect.left - 10) / Math.max(1, rect.width - 20)));
    return 1 + Math.round(r * (currentDoc.numPages - 1));
  }
  pageSlider.addEventListener("pointerdown", function(e){
    if(!currentDoc || e.button > 0) return;
    sliderDrag = {id: e.pointerId, x: e.clientX, y: e.clientY, active: false, page: pageAnchor};
  });
  pageSlider.addEventListener("pointermove", function(e){
    var d = sliderDrag;
    if(!d || e.pointerId !== d.id || !currentDoc) return;
    if(!d.active){
      var dx = Math.abs(e.clientX - d.x), dy = Math.abs(e.clientY - d.y);
      if(dy > 8 && dy >= dx){ sliderDrag = null; return; }   // 縦の動きは無視
      if(dx <= 8) return;
      d.active = true;
      try{ pageSlider.setPointerCapture(e.pointerId); }catch(err){}
      pageSlider.classList.add("dragging");
    }
    var p = sliderPageAt(e.clientX);
    if(p === d.page) return;
    d.page = p;
    sliderSet(p, currentDoc.numPages);
    pageIndicator.textContent = p + " / " + currentDoc.numPages;
    // 動かしている間も、少し間引いてページを描く
    if(!sliderRenderTimer){
      sliderRenderTimer = setTimeout(function(){
        sliderRenderTimer = null;
        if(sliderDrag && sliderDrag.active) goTo(sliderDrag.page);
      }, 200);
    }
  });
  function sliderEnd(e){
    var d = sliderDrag;
    if(!d || e.pointerId !== d.id) return;
    sliderDrag = null;
    pageSlider.classList.remove("dragging");
    clearTimeout(sliderRenderTimer); sliderRenderTimer = null;
    if(d.active) goTo(d.page);
  }
  pageSlider.addEventListener("pointerup", sliderEnd);
  pageSlider.addEventListener("pointercancel", sliderEnd);

  /* ---------- 拡大 ----------
     ブラウザの拡大は止めて、アプリがページだけを拡大する。
     ピンチ中は描いた画像を引き伸ばして見せ、指を離したらその倍率で描き直してくっきりさせる。
     zoom: 見た目の倍率 / renderedZoom: 今の画像を描いた倍率 / panX, panY: 中央からのずれ(px) */
  var MIN_ZOOM = 1, MAX_ZOOM = 4;
  var MAX_CANVAS_PX = 16777216;
  var zoom = 1, renderedZoom = 1, panX = 0, panY = 0, fitW = 0, fitH = 0;
  function isZoomed(){ return zoom > 1.01; }
  function applyTransform(){
    var k = zoom / renderedZoom;
    pageWrap.style.transform = "translate(" + panX + "px," + panY + "px)" + (k !== 1 ? " scale(" + k + ")" : "");
    pageArea.classList.toggle("zoomed", isZoomed());
  }
  function clampPan(){
    var mx = Math.max(0, (fitW * zoom - pageArea.clientWidth) / 2);
    var my = Math.max(0, (fitH * zoom - pageArea.clientHeight) / 2);
    panX = Math.min(mx, Math.max(-mx, panX));
    panY = Math.min(my, Math.max(-my, panY));
  }
  function resetZoom(){ zoom = 1; panX = 0; panY = 0; }

  // ページの上の指の操作: ピンチ=拡大、拡大中の1本指=位置を動かす、等倍のスワイプ=ページをめくる、ダブルタップ=等倍に戻す
  var gesture = null, lastTap = null, suppressClickUntil = 0;
  function areaPoint(t){
    var r = pageArea.getBoundingClientRect();
    return {x: t.clientX - r.left - r.width / 2, y: t.clientY - r.top - r.height / 2};
  }
  /* 選択モードでも、1本指で見える位置を動かせるようにする。
     ただし、選んだ範囲の端のつまみを動かしているとき(=選択を広げているとき)は動かさない。
     つまみの動きは端末が扱っていてアプリからは見えないので、
     「選んだ範囲の端の近くで触れた」か「指を動かしている間に選択が変わった」で見分ける。 */
  var selVersion = 0;
  document.addEventListener("selectionchange", function(){ selVersion++; });
  function hasSelection(){
    var s = window.getSelection();
    return !!(s && s.rangeCount && !s.isCollapsed);
  }
  function nearSelectionEnd(t){
    if(!hasSelection()) return false;
    var rects = window.getSelection().getRangeAt(0).getClientRects();
    if(!rects.length) return false;
    var a = rects[0], b = rects[rects.length - 1];
    var R = 44;
    return (Math.abs(t.clientX - a.left) < R && t.clientY > a.top - R && t.clientY < a.bottom + R) ||
           (Math.abs(t.clientX - b.right) < R && t.clientY > b.top - R && t.clientY < b.bottom + R);
  }

  pageArea.addEventListener("touchstart", function(e){
    if(!currentDoc) return;
    if(selectMode && e.touches.length === 1 && nearSelectionEnd(e.touches[0])){ gesture = null; return; }
    if(e.touches.length === 2){
      var a = areaPoint(e.touches[0]), b = areaPoint(e.touches[1]);
      gesture = {type: "pinch", z0: zoom, px0: panX, py0: panY,
        fx: (a.x + b.x) / 2, fy: (a.y + b.y) / 2, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1};
      // 2本指で触れた時点で端末が選択を外すことがあるので、先に覚えておく
      if(selectMode) pendingSel = saveSelection() || pendingSel;
      e.preventDefault();
    } else if(e.touches.length === 1 && !gesture){
      var t = e.touches[0];
      gesture = {type: "one", x0: t.clientX, y0: t.clientY, px0: panX, py0: panY, moved: false, t0: Date.now(), sel: selVersion};
    }
  }, {passive: false});
  pageArea.addEventListener("touchmove", function(e){
    var g = gesture;
    if(!g) return;
    if(g.type === "pinch" && e.touches.length >= 2){
      var a = areaPoint(e.touches[0]), b = areaPoint(e.touches[1]);
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      var fx = (a.x + b.x) / 2, fy = (a.y + b.y) / 2;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.z0 * d / g.d0));
      // ピンチを始めたときに指の間にあった点が、今の指の間に来るように動かす
      panX = fx - (zoom / g.z0) * (g.fx - g.px0);
      panY = fy - (zoom / g.z0) * (g.fy - g.py0);
      clampPan();
      applyTransform();
      e.preventDefault();
    } else if(g.type === "one" && e.touches.length === 1){
      var t = e.touches[0];
      var dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if(Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;
      if(selectMode){
        // 指を動かしている間に選択が変わった → 選択を広げている。動かした分を戻して、以後は動かさない
        if(g.sel !== selVersion && hasSelection()){
          panX = g.px0; panY = g.py0;
          clampPan();
          applyTransform();
          gesture = null;
          return;
        }
        // 端末の文字選択を邪魔しないよう、preventDefault はしない
        if(isZoomed()){
          panX = g.px0 + dx; panY = g.py0 + dy;
          clampPan();
          applyTransform();
        }
        return;
      }
      if(isZoomed()){
        panX = g.px0 + dx; panY = g.py0 + dy;
        clampPan();
        applyTransform();
        e.preventDefault();
      }
    }
  }, {passive: false});
  pageArea.addEventListener("touchend", function(e){
    var g = gesture;
    if(!g) return;
    if(g.type === "pinch"){
      if(e.touches.length >= 2) return;
      gesture = null;
      suppressClickUntil = Date.now() + 400;
      if(!isZoomed()) resetZoom();
      if(zoom !== renderedZoom) renderPages();
      else {
        clampPan(); applyTransform(); scheduleDetail();
        if(pendingSel){ if(!hasSelection()) restoreSelection(pendingSel); pendingSel = null; }
      }
      return;
    }
    gesture = null;
    // 選択モードでは、めくる・ダブルタップはしない(動かしたあとの描き直しだけ)
    if(selectMode){
      if(g.moved && isZoomed()) scheduleDetail();
      return;
    }
    var t = e.changedTouches[0];
    var dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if(g.moved){
      suppressClickUntil = Date.now() + 400;
      if(isZoomed()) scheduleDetail();
      if(!isZoomed() && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)){ if(dx < 0) goNext(); else goPrev(); }
      lastTap = null;
      return;
    }
    // ダブルタップ: 拡大しているときだけ等倍に戻す(拡大はしない)
    var now = Date.now();
    if(lastTap && now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30){
      lastTap = null;
      if(isZoomed()){ resetZoom(); renderPages(); }
    } else {
      lastTap = {t: now, x: t.clientX, y: t.clientY};
    }
  });
  pageArea.addEventListener("touchcancel", function(){ gesture = null; });

  // ブラウザ自体の拡大を止める(iPad の Safari は viewport の指定を無視するため)
  document.addEventListener("gesturestart", function(e){ e.preventDefault(); });
  document.addEventListener("touchmove", function(e){
    if(e.touches.length > 1) e.preventDefault();
  }, {passive: false});

  /* ---------- 文字の選択(コピー用) ----------
     上のバーの「選択」を押している間だけ、ページに文字の層を重ねて、長押し・なぞりで選べるようにする。
     その間は、めくる・拡大・中央タップの操作を止める(文字を選ぶ指の動きとぶつかるため)。 */
  var selectMode = false;
  function addTextLayer(page, viewport, box){
    var div = document.createElement("div");
    div.className = "textLayer";
    div.style.setProperty("--scale-factor", viewport.scale);
    box.appendChild(div);
    return page.getTextContent().then(function(tc){
      return pdfjsLib.renderTextLayer({textContentSource: tc, container: div, viewport: viewport, textDivs: []}).promise;
    }).catch(function(err){ console.error(err); });
  }
  function setSelectMode(v){
    if(selectMode === v) return;
    selectMode = v;
    $("select-btn").classList.toggle("active", v);
    pageArea.classList.toggle("selecting", v);
    if(v){
      var info = renderInfo;
      if(info && info.seq === renderSeq){
        info.boxes.forEach(function(box, i){
          if(!box.querySelector(".textLayer")) addTextLayer(info.pages[i], info.pages[i].getViewport({scale: info.scale}), box);
        });
      }
      toast("文字を長押しして選び、コピーできます");
    } else {
      pageWrap.querySelectorAll(".textLayer").forEach(function(d){ d.remove(); });
      try{ window.getSelection().removeAllRanges(); }catch(e){}
    }
  }
  $("select-btn").addEventListener("click", function(){ setSelectMode(!selectMode); });

  // 選んでいる範囲を「どのページの、何番目の文字のかたまりの、何文字目か」で覚える。
  // 描き直した文字の層は中身も並びも同じなので、同じ番号で選び直せる。
  var pendingSel = null;
  function selPoint(node, offset){
    var el = node.nodeType === 3 ? node.parentNode : node;
    var span = el && el.closest ? el.closest(".textLayer span") : null;
    if(!span) return null;
    var layer = span.closest(".textLayer");
    var spans = layer.querySelectorAll("span");
    return {
      page: layer.parentNode.dataset.page,
      idx: Array.prototype.indexOf.call(spans, span),
      off: node.nodeType === 3 ? offset : (offset > 0 ? span.textContent.length : 0)
    };
  }
  function saveSelection(){
    if(!hasSelection()) return null;
    var r = window.getSelection().getRangeAt(0);
    var a = selPoint(r.startContainer, r.startOffset), b = selPoint(r.endContainer, r.endOffset);
    return (a && b) ? {a: a, b: b} : null;
  }
  function selNode(p){
    var box = pageWrap.querySelector('.pg[data-page="' + p.page + '"]');
    var layer = box && box.querySelector(".textLayer");
    var span = layer && layer.querySelectorAll("span")[p.idx];
    if(!span) return null;
    var tn = span.firstChild && span.firstChild.nodeType === 3 ? span.firstChild : span;
    return {node: tn, off: tn === span ? 0 : Math.min(p.off, tn.length)};
  }
  function restoreSelection(s){
    var a = selNode(s.a), b = selNode(s.b);
    if(!a || !b) return;
    try{
      var r = document.createRange();
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }catch(e){ console.error(e); }
  }
  // コピーするとき、日本語の行の途中の改行(PDFの行の折り返し)を外して、1つの文にする
  document.addEventListener("copy", function(e){
    if(!selectMode || !e.clipboardData) return;
    var text = String(window.getSelection() || "");
    if(!text) return;
    e.clipboardData.setData("text/plain", text.replace(/([^\x00-\x7F])\n+(?=[^\x00-\x7F])/g, "$1"));
    e.preventDefault();
  });

  // 中央タップで UI を隠す
  var uiHidden = false;
  function setUiHidden(v){
    uiHidden = v;
    viewerHeader.classList.toggle("hidden-ui", v);
    viewerFooter.classList.toggle("hidden-ui", v);
    // 全画面のときは、ページの影を消す
    pageArea.classList.toggle("fullscreen", v);
  }
  pageArea.addEventListener("click", function(e){
    if(e.target.closest(".nav-zone")) return;
    if(selectMode) return;
    if(Date.now() < suppressClickUntil) return;
    setUiHidden(!uiHidden);
  });

  var resizeTimer = null;
  window.addEventListener("resize", function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){ if(currentDoc){ resetZoom(); renderPages(); } }, 150);
  });

  /* ---------- 目次(PDFに埋め込まれたアウトライン) ---------- */
  var outlinePromise = null;
  var tocOverlay = $("toc-overlay"), tocList = $("toc-list"), tocStatus = $("toc-status");

  // アウトラインを {title, page, children, depth} の木にする。page は1始まり(移動先がなければ null)
  function loadOutline(){
    if(outlinePromise) return outlinePromise;
    var doc = currentDoc;
    outlinePromise = doc.getOutline().then(function(items){
      var nodes = [];
      function resolvePage(dest){
        var p = typeof dest === "string" ? doc.getDestination(dest) : Promise.resolve(dest);
        return p.then(function(d){
          if(!Array.isArray(d) || d[0] == null) return null;
          if(typeof d[0] === "number") return d[0] + 1;
          return doc.getPageIndex(d[0]).then(function(i){ return i + 1; });
        }).catch(function(){ return null; });
      }
      function build(list, depth){
        return Promise.all((list || []).map(function(it){
          return Promise.all([it.dest ? resolvePage(it.dest) : Promise.resolve(null), build(it.items, depth + 1)])
            .then(function(r){
              var n = {title: (it.title || "").trim() || "(無題)", page: r[0], children: r[1], depth: depth};
              return n;
            });
        }));
      }
      return build(items, 0).then(function(tree){
        (function walk(list, parent){
          list.forEach(function(n){ n.parent = parent; n.idx = nodes.length; nodes.push(n); walk(n.children, n); });
        })(tree, null);
        return {tree: tree, nodes: nodes};
      });
    }).catch(function(err){
      console.error(err);
      outlinePromise = null;
      throw err;
    });
    return outlinePromise;
  }

  // 今の位置: 表示中の最後のページ以前で始まる項目のうち、いちばん後ろのもの
  function currentTocNode(nodes){
    var last = pagesShown(pageAnchor, currentDoc.numPages).slice(-1)[0];
    var best = null;
    nodes.forEach(function(n){
      if(n.page != null && n.page <= last && (!best || n.page >= best.page)) best = n;
    });
    return best;
  }

  $("toc-btn").addEventListener("click", function(){
    if(!currentDoc) return;
    tocOverlay.classList.add("active");
    pushUi("toc");
    tocList.innerHTML = "";
    tocStatus.textContent = "読み込み中…";
    loadOutline().then(function(o){
      if(o.nodes.length === 0){ tocStatus.textContent = "このPDFにはアウトラインがありません"; return; }
      tocStatus.textContent = "";
      renderToc(o);
    }).catch(function(){ tocStatus.textContent = "アウトラインを読み込めませんでした"; });
  });
  $("toc-close").addEventListener("click", uiBack);

  function renderToc(o){
    var cur = currentTocNode(o.nodes);
    // 最初は2階層目まで開き、今の位置の上の階層も開いておく
    var open = {};
    o.nodes.forEach(function(n){ if(n.depth < 1) open[n.idx] = true; });
    for(var p = cur && cur.parent; p; p = p.parent) open[p.idx] = true;

    var frag = document.createDocumentFragment();
    var curEl = null;
    (function add(list, container){
      list.forEach(function(n){
        var li = document.createElement("li");
        var row = document.createElement("div");
        row.className = "toc-row" + (n === cur ? " cur" : "") + (n.page == null ? " nolink" : "");
        row.style.paddingLeft = (4 + n.depth * 18) + "px";
        var tog = document.createElement("button");
        tog.className = "toc-tog";
        var title = document.createElement("span");
        title.className = "toc-title";
        title.textContent = n.title;
        var pg = document.createElement("span");
        pg.className = "toc-pg";
        pg.textContent = n.page != null ? n.page : "";
        row.appendChild(tog); row.appendChild(title); row.appendChild(pg);
        li.appendChild(row);
        if(n.children.length){
          var sub = document.createElement("ul");
          sub.hidden = !open[n.idx];
          tog.textContent = sub.hidden ? "▸" : "▾";
          tog.addEventListener("click", function(e){
            e.stopPropagation();
            sub.hidden = !sub.hidden;
            tog.textContent = sub.hidden ? "▸" : "▾";
          });
          add(n.children, sub);
          li.appendChild(sub);
        } else {
          tog.disabled = true;
        }
        if(n.page != null){
          row.addEventListener("click", function(){
            uiBack();
            setUiHidden(false);
            goTo(n.page);
          });
        }
        if(n === cur) curEl = row;
        container.appendChild(li);
      });
    })(o.tree, frag);
    tocList.appendChild(frag);
    if(curEl) curEl.scrollIntoView({block: "center"});
  }

  /* ---------- 検索 ---------- */
  var searchOverlay = $("search-overlay"), searchInput = $("search-input");
  var searchStatus = $("search-status"), searchResults = $("search-results");

  $("search-btn").addEventListener("click", function(){
    searchOverlay.classList.add("active");
    pushUi("search");
    searchStatus.textContent = "";
    setTimeout(function(){ searchInput.focus(); searchInput.select(); }, 50);
    if(!currentIndex && currentDoc) ensureIndex().catch(function(){});
  });
  $("search-close").addEventListener("click", uiBack);
  function closeSearchOverlay(){ searchOverlay.classList.remove("active"); searchInput.blur(); }

  function ensureIndex(){
    if(currentIndex) return Promise.resolve(currentIndex);
    if(indexPromise) return indexPromise;
    var doc = currentDoc, book = currentBook;
    if(!doc) return Promise.reject(new Error("no doc"));
    var pages = [], i = 1;
    function step(){
      if(currentDoc !== doc) throw new Error("closed");
      if(i > doc.numPages){
        return dbPut("texts", {id: book.id, v: INDEX_VERSION, pages: pages}).catch(function(e){ console.error(e); })
          .then(function(){ currentIndex = pages; searchStatus.textContent = ""; return pages; });
      }
      searchStatus.textContent = "検索用の索引を作成中… " + i + " / " + doc.numPages + "(初回のみ)";
      return doc.getPage(i).then(function(page){
        return page.getTextContent();
      }).then(function(content){
        pages.push(buildNorm(content.items, false).text);
        i++;
        return step();
      });
    }
    indexPromise = step().catch(function(err){
      indexPromise = null;
      throw err;
    });
    return indexPromise;
  }

  var searchTimer = null;
  searchInput.addEventListener("input", function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ runSearch(searchInput.value); }, 250);
  });
  searchInput.addEventListener("keydown", function(e){
    // 日本語入力の変換を確定する Enter では、検索も、欄から抜けることもしない(0.10.4)。
    // Safari は isComposing を正しく返さないことがあるので、変換中の keyCode 229 も見る(Modern Web Guidance「ime-safe-enter-submit」)
    if(e.key === "Enter" && !(e.isComposing || e.keyCode === 229)){ clearTimeout(searchTimer); runSearch(searchInput.value); searchInput.blur(); }
  });

  function runSearch(raw){
    var q = normStr(raw);
    if(!q){ searchResults.innerHTML = ""; if(currentIndex) searchStatus.textContent = ""; return; }
    ensureIndex().then(function(pages){
      if(normStr(searchInput.value) !== q) return;   // 打ち直された
      var found = [];
      for(var i=0;i<pages.length && found.length < MAX_HITS;i++){
        var cur = pages[i], next = pages[i+1] || "";
        // 次のページの先頭を足して、ページをまたぐ語も拾う
        var hay = cur + next.slice(0, q.length - 1);
        var ctx = cur + next.slice(0, 40);
        var ps = findAll(hay, q, cur.length);
        for(var j=0;j<ps.length && found.length < MAX_HITS;j++){
          var pos = ps[j];
          var s = Math.max(0, pos - 18);
          var e = Math.min(ctx.length, pos + q.length + 30);
          found.push({
            page: i + 1, pos: pos,
            snippet: (s > 0 ? "…" : "") + escapeHtml(ctx.slice(s, pos)) +
              "<b>" + escapeHtml(ctx.slice(pos, pos + q.length)) + "</b>" +
              escapeHtml(ctx.slice(pos + q.length, e)) + (e < ctx.length ? "…" : "")
          });
        }
      }
      showResults(q, found);
    }).catch(function(err){
      if(err && err.message === "closed") return;
      console.error(err);
      searchStatus.textContent = "索引を作れませんでした";
    });
  }

  function showResults(q, found){
    searchResults.innerHTML = "";
    if(found.length === 0){
      searchStatus.textContent = "「" + searchInput.value.trim() + "」に一致する結果はありません";
      return;
    }
    searchStatus.textContent = (found.length >= MAX_HITS ? MAX_HITS + "件以上" : found.length + "件") + "ヒットしました";
    var frag = document.createDocumentFragment();
    found.forEach(function(h, idx){
      var li = document.createElement("li");
      li.innerHTML = '<div class="snip">' + h.snippet + '</div><div class="pg-no">' + h.page + ' ページ</div>';
      li.addEventListener("click", function(){
        activeQuery = q; activeLabel = searchInput.value.trim(); hits = found; hitCursor = idx;
        updateHitBar();
        uiBack();
        setUiHidden(false);
        goTo(h.page);
      });
      frag.appendChild(li);
    });
    searchResults.appendChild(frag);
  }

  function updateHitBar(){
    var on = !!activeQuery && hits.length > 0;
    $("hit-bar").classList.toggle("active", on);
    if(!on) return;
    $("hit-q").textContent = "「" + activeLabel + "」";
    $("hit-count").textContent = (hitCursor + 1) + " / " + hits.length;
    $("hit-prev").disabled = hitCursor <= 0;
    $("hit-next").disabled = hitCursor >= hits.length - 1;
  }
  function clearHits(){
    activeQuery = ""; hits = []; hitCursor = -1;
    updateHitBar();
  }
  $("hit-prev").addEventListener("click", function(){
    if(hitCursor > 0){ hitCursor--; updateHitBar(); goTo(hits[hitCursor].page); }
  });
  $("hit-next").addEventListener("click", function(){
    if(hitCursor < hits.length - 1){ hitCursor++; updateHitBar(); goTo(hits[hitCursor].page); }
  });
  $("hit-clear").addEventListener("click", function(){
    clearHits();
    pageWrap.querySelectorAll(".hl-layer").forEach(function(l){ l.innerHTML = ""; });
  });

  /* ---------- ページ上のハイライト ---------- */
  function drawHighlights(page, pageNo, viewport, layer, seq){
    var q = activeQuery;
    page.getTextContent().then(function(content){
      if(seq !== renderSeq || q !== activeQuery) return;
      var nm = buildNorm(content.items, true);
      var cur = nm.text, map = nm.map;
      var idx = currentIndex || [];
      var k = q.length - 1;
      // 前後のページの端を足して、ページをまたぐ語のこちら側も塗る
      var prevTail = k > 0 ? (idx[pageNo - 2] || "").slice(-k) : "";
      var nextHead = k > 0 ? (idx[pageNo] || "").slice(0, k) : "";
      var hay = prevTail + cur + nextHead;
      var off = prevTail.length;
      var curHit = hits[hitCursor];
      var sameAsIndex = idx[pageNo - 1] === cur;
      var ps = findAll(hay, q, hay.length);
      var frag = document.createDocumentFragment();
      ps.forEach(function(p0){
        var a = Math.max(p0, off) - off;
        var b = Math.min(p0 + q.length, off + cur.length) - off;
        if(a >= b) return;
        var isCur = !!curHit && sameAsIndex && curHit.page === pageNo && curHit.pos === p0 - off;
        rectsFor(content.items, map, a, b, viewport).forEach(function(r){
          var el = document.createElement("i");
          if(isCur) el.className = "cur";
          el.style.left = r[0] + "px"; el.style.top = r[1] + "px";
          el.style.width = r[2] + "px"; el.style.height = r[3] + "px";
          frag.appendChild(el);
        });
      });
      layer.appendChild(frag);
    }).catch(function(err){ console.error(err); });
  }

  // 整えた文字列の [a, b) を、元の文字のかたまりごとの長方形に直す
  function rectsFor(items, map, a, b, viewport){
    var rects = [], j = a;
    while(j < b){
      var item = map[j*3], s = map[j*3+1], e = s + map[j*3+2];
      var j2 = j + 1;
      while(j2 < b && map[j2*3] === item){
        e = map[j2*3+1] + map[j2*3+2];
        j2++;
      }
      var r = itemRect(items[item], s, e, viewport);
      if(r) rects.push(r);
      j = j2;
    }
    return rects;
  }
  function itemRect(item, s, e, viewport){
    var t = item.transform, len = item.str.length || 1;
    var fontH = Math.hypot(t[2], t[3]) || item.height || 10;
    var x1, x2, y1, y2;
    if(Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3){
      // 横書き: 文字幅は均等とみなして按分する
      x1 = t[4] + item.width * (s / len);
      x2 = t[4] + item.width * (e / len);
      y1 = t[5] - fontH * 0.22;
      y2 = t[5] + fontH * 0.88;
    } else {
      // 回転・縦書きは、かたまり全体を囲う
      x1 = t[4]; x2 = t[4] + Math.max(item.width, fontH);
      y1 = t[5] - Math.max(item.height, fontH); y2 = t[5] + fontH;
    }
    var v = viewport.convertToViewportRectangle([x1, y1, x2, y2]);
    var L = Math.min(v[0], v[2]), T = Math.min(v[1], v[3]);
    return [L, T, Math.abs(v[2] - v[0]), Math.abs(v[3] - v[1])];
  }

  /* ---------- 設定・バックアップ ---------- */
  $("settings-btn").addEventListener("click", openSettings);
  var importInput = $("import-input");

  function openSettings(){
    var est = (navigator.storage && navigator.storage.estimate) ? navigator.storage.estimate().catch(function(){ return null; }) : Promise.resolve(null);
    var per = (navigator.storage && navigator.storage.persisted) ? navigator.storage.persisted().catch(function(){ return null; }) : Promise.resolve(null);
    Promise.all([est, per, dbAll("books")]).then(function(r){
      var e = r[0], p = r[1], books = r[2];
      var total = books.reduce(function(s, b){ return s + (b.size || 0); }, 0);
      var offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      showModal(
        '<h2>設定</h2>' +
        '<table class="info-table">' +
        '<tr><td>本棚</td><td>' + books.length + '冊・PDF ' + fmtMB(total) + '</td></tr>' +
        (e ? '<tr><td>保存容量(使用/上限の目安)</td><td>' + fmtMB(e.usage || 0) + ' / ' + fmtMB(e.quota || 0) + '</td></tr>' : '') +
        '<tr><td>データの保護</td><td>' + (p === true ? '有効' : p === false ? '無効(容量不足のとき消される可能性)' : '不明') + '</td></tr>' +
        '<tr><td>オフライン</td><td>' + (offline ? '準備完了' : '未準備') + '</td></tr>' +
        '</table>' +
        '<button class="modal-btn plain block" id="ms-export">バックアップを書き出す</button>' +
        '<button class="modal-btn plain block" id="ms-import">バックアップを読み込む</button>' +
        '<p class="note">バックアップに入るのは、書名・表示名・科目・タグ・最後に読んだページ・表示の設定だけです。PDFは入りません。機種変更のときは、新しい端末でPDFを追加し、このファイルを読み込んでください(順番はどちらが先でもかまいません)。</p>' +
        '<button class="modal-btn plain" id="ms-close" style="width:100%;">閉じる</button>' +
        '<div class="about"><div class="about-name">DIGITAL教材</div>' +
        '<div>バージョン ' + APP_VERSION + '</div>' +
        '<div>© 2026 taichi-tools</div></div>',
        function(sheet, close){
          sheet.querySelector("#ms-close").addEventListener("click", close);
          sheet.querySelector("#ms-export").addEventListener("click", function(){ exportBackup(); });
          sheet.querySelector("#ms-import").addEventListener("click", function(){ close(); importInput.click(); });
        }
      );
    });
  }

  function prepareBackupBook(b){
    var out = {
      fingerprint: b.fingerprint, title: b.title,
      lastPage: b.lastPage, numPages: b.numPages, size: b.size
    };
    if(typeof b.displayName === "string" && b.displayName.trim()) out.displayName = b.displayName.trim();
    if(typeof b.subject === "string" && b.subject.trim()) out.subject = b.subject.trim();
    var tags = normalizeTags(b.tags);
    if(tags.length) out.tags = tags;
    return out;
  }
  function applyBackupFields(target, src){
    if(!src) return target;
    if(src.title) target.title = String(src.title);
    if(src.lastPage){
      var lp = Math.max(1, src.lastPage | 0);
      target.lastPage = target.numPages ? Math.min(lp, target.numPages) : lp;
    }
    if(typeof src.displayName === "string"){
      var dn = src.displayName.trim();
      if(dn) target.displayName = dn;
      else delete target.displayName;
    }
    if(typeof src.subject === "string"){
      var sub = src.subject.trim();
      if(sub) target.subject = sub;
      else delete target.subject;
    }
    if(Array.isArray(src.tags)){
      var tags = normalizeTags(src.tags.filter(function(t){ return typeof t === "string"; }));
      if(tags.length) target.tags = tags;
      else delete target.tags;
    }
    return target;
  }

  function exportBackup(){
    Promise.all([dbAll("books"), dbGet("kv", "pending")]).then(function(r){
      var books = r[0].map(prepareBackupBook);
      // まだPDFを入れていない本の情報も引き継ぐ
      var pend = (r[1] && r[1].items) || [];
      pend.forEach(function(x){
        if(!books.some(function(b){ return b.fingerprint === x.fingerprint; })) books.push(prepareBackupBook(x));
      });
      var data = {
        app: "bunko", format: 1, exportedAt: new Date().toISOString(),
        settings: {theme: lsGet("bunko-theme", "system"), spread: spread},
        books: books
      };
      saveTextFile("bunko-backup-" + today() + ".json", JSON.stringify(data, null, 1));
    });
  }

  function saveTextFile(name, text){
    var blob = new Blob([text], {type: "application/json"});
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var file = null;
    try{ file = new File([blob], name, {type: "application/json"}); }catch(e){}
    if(isIOS && file && navigator.canShare && navigator.canShare({files: [file]})){
      navigator.share({files: [file]}).catch(function(err){
        if(err && err.name !== "AbortError") download();
      });
      return;
    }
    download();
    function download(){
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      toast("書き出しました");
    }
  }

  importInput.addEventListener("change", function(){
    var f = importInput.files && importInput.files[0];
    importInput.value = "";
    if(!f) return;
    f.text().then(function(text){
      var data = JSON.parse(text);
      if(!data || data.app !== "bunko" || !Array.isArray(data.books)) throw new Error("format");
      return importBackup(data);
    }).catch(function(err){
      console.error(err);
      toast("このファイルは読み込めません", 3500);
    });
  });

  function importBackup(data){
    if(data.settings){
      if(data.settings.theme){ lsSet("bunko-theme", data.settings.theme); applyTheme(data.settings.theme); }
      spread = !!data.settings.spread;
      lsSet("bunko-spread", spread ? "1" : "0");
      spreadBtn.classList.toggle("active", spread);
    }
    return Promise.all([dbAll("books"), dbGet("kv", "pending")]).then(function(r){
      var local = r[0];
      var pend = (r[1] && r[1].items) || [];
      var applied = 0, waiting = 0, puts = [];
      data.books.forEach(function(x){
        if(!x || !x.fingerprint) return;
        var m = local.filter(function(b){ return b.fingerprint === x.fingerprint; })[0];
        if(m){
          applyBackupFields(m, x);
          if(!m.numPages) m.lastPage = 1;
          puts.push(m);
          applied++;
        } else {
          pend = pend.filter(function(p){ return p.fingerprint !== x.fingerprint; });
          pend.push(applyBackupFields({fingerprint: x.fingerprint, numPages: x.numPages, size: x.size}, x));
          waiting++;
        }
      });
      return tx(["books","kv"], "readwrite", function(t){
        puts.forEach(function(m){ t.objectStore("books").put(m); });
        t.objectStore("kv").put({id: "pending", items: pend});
      }).then(function(){
        renderShelf();
        var msg = applied + "冊に反映しました";
        if(waiting) msg += "／" + waiting + "冊は、PDFを追加したときに反映します";
        toast(msg, 4500);
      });
    });
  }

  // 追加したPDFが、読み込み済みのバックアップにあれば、書名と最後のページを引き継ぐ
  function applyPending(meta){
    if(!meta.fingerprint) return Promise.resolve();
    return dbGet("kv", "pending").then(function(rec){
      var items = (rec && rec.items) || [];
      var m = items.filter(function(x){ return x.fingerprint === meta.fingerprint; })[0];
      if(!m) return;
      applyBackupFields(meta, m);
      rec.items = items.filter(function(x){ return x !== m; });
      return dbPut("kv", rec);
    });
  }

  /* ---------- 起動 ---------- */
  /* 更新のお知らせ
     新しい版は裏で受け取る。受け取り終えたら画面の下に知らせて、タップでその場で切り替える
     (以前は「2回開き直す」必要があり、分かりにくかった。2026-09-28 のレビューで指摘)。
     アプリに戻ってきたときにも、新しい版がないか確かめる。 */
  var swReg = null;
  function showUpdateBar(){
    if($("update-bar")) return;
    var bar = document.createElement("div");
    bar.id = "update-bar";
    bar.innerHTML = '<span>新しいバージョンがあります</span><button class="update-go">更新</button><button class="update-x" aria-label="閉じる">×</button>';
    bar.querySelector(".update-go").addEventListener("click", function(){
      // 読んでいた本は、読み込み直したあとに開き直す
      var done = Promise.resolve();
      if(currentBook){
        currentBook.lastPage = pageAnchor;
        try{ sessionStorage.setItem("bunko-reopen", currentBook.id); }catch(e){}
        done = dbPut("books", currentBook).catch(function(){});
      }
      done.then(function(){ location.reload(); });
    });
    bar.querySelector(".update-x").addEventListener("click", function(){ bar.remove(); });
    document.body.appendChild(bar);
  }
  if("serviceWorker" in navigator && location.protocol !== "file:"){
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(function(reg){ swReg = reg; reg.update().catch(function(){}); }).catch(function(err){ console.error(err); });
    // 新しい版が働き始めた(初めて開いたときは除く)
    navigator.serviceWorker.addEventListener("controllerchange", function(){
      if(hadController) showUpdateBar();
      hadController = true;
    });
    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible" && swReg) swReg.update().catch(function(){});
    });
  }
  // Android の共有メニューから受け取ったPDFを取り出す(sw.js が入れ物「share-inbox」に置き、?share=件数 で開き直す)
  function takeShared(){
    if(!/[?&]share=/.test(location.search) || !window.caches) return Promise.resolve([]);
    try{ window.history.replaceState(null, "", location.pathname); }catch(e){}
    return caches.open("share-inbox").then(function(c){
      return c.keys().then(function(keys){
        keys.sort(function(a, b){ return +a.url.split("/").pop() - +b.url.split("/").pop(); });
        return Promise.all(keys.map(function(k){
          return c.match(k).then(function(r){
            return r.blob().then(function(b){
              return new File([b], decodeURIComponent(r.headers.get("X-Name") || "shared.pdf"), {type: "application/pdf"});
            });
          });
        }));
      });
    }).catch(function(err){ console.error(err); return []; });
  }
  renderShelf().then(function(){
    return takeShared();
  }).then(function(shared){
    if(shared.length){
      // 追加できなかったものがあれば、入れ物に残す(次の共有で置き換わるまで、失わない)
      addFiles(shared, true).then(function(failed){
        if(failed === 0) caches.delete("share-inbox").catch(function(){});
      });
      return;
    }
    var reopen = null;
    try{ reopen = sessionStorage.getItem("bunko-reopen"); sessionStorage.removeItem("bunko-reopen"); }catch(e){}
    if(reopen) openBook(reopen);
  });

  // テスト用に内部の関数を出しておく(画面の動作には使わない)
  window.__bunko = {
    normStr: normStr, buildNorm: buildNorm, findAll: findAll,
    yearOf: yearOf, computeHiddenYear: computeHiddenYear, displayTitle: displayTitle, bookDisplayTitle: bookDisplayTitle,
    subjectOf: subjectOf, bookSubject: bookSubject, collectCustomSubjects: collectCustomSubjects, orderedSubjects: orderedSubjects,
    normalizeTag: normalizeTag, normalizeTags: normalizeTags, collectTags: collectTags, filterBooksByTags: filterBooksByTags,
    prepareBackupBook: prepareBackupBook, applyBackupFields: applyBackupFields
  };
})();

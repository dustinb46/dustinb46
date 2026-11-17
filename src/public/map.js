// Layered atlas map (/map). Plain browser JS, no build step.
//
// The page is one map with many views. A view is { lens, layers, days }:
//   - a lens is a question with a fixed set of layers (defined once, in
//     src/records.js, and handed to this script as JSON);
//   - "custom" lets the reader pick the layers;
//   - days is the time window for dated records.
// The view lives in the URL, so every view can be linked.
//
// Data comes from two endpoints: /api/plants/geo.json (the plant base)
// and /api/records.json (news, recalls and dispersals in one shape).
// A layer is a filter on a record's type. The "what changed" panel is
// the same records, newest first.
(function () {
  'use strict';

  var bootEl = document.getElementById('atlas-boot');
  var mapEl = document.getElementById('atlas-map');
  if (!bootEl || !mapEl) return;
  var boot = JSON.parse(bootEl.textContent);

  var RECORD_LAYERS = ['events', 'dispersals', 'recalls'];
  var FEED_LIMIT = 8;
  var NEAREST_LIMIT = 12;
  var METERS_PER_MILE = 1609.344;

  var state = {
    lens: boot.view.lens,
    layers: new Set(boot.view.layers),
    days: boot.view.days,
    radiusMiles: 50,
    radiusCenter: null,
  };
  var records = [];
  var facilities = [];   // processing plants (the base layer and the radius count)
  var supplySites = [];  // bulk tank units and receiving/transfer stations
  var recordsError = null;
  var recordsLoaded = false;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    lensBtns: Array.prototype.slice.call(document.querySelectorAll('.lens-btn')),
    layerBar: $('atlas-layers'),
    layerBoxes: Array.prototype.slice.call(document.querySelectorAll('#atlas-layers input[data-layer]')),
    days: $('atlas-days'),
    cardTitle: $('atlas-card-title'),
    cardBlurb: $('atlas-card-blurb'),
    key: $('atlas-key'),
    radius: $('atlas-radius'),
    radiusMiles: $('atlas-radius-miles'),
    radiusHint: $('atlas-radius-hint'),
    radiusResult: $('atlas-radius-result'),
    feed: $('atlas-feed'),
    feedNote: $('atlas-feed-note'),
    feedList: $('atlas-feed-list'),
    feedEmpty: $('atlas-feed-empty'),
    rss: $('atlas-rss'),
    copy: $('atlas-copy'),
  };

  // ---------- small helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Only http(s) links are ever written into an href.
  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  function currentLens() {
    for (var i = 0; i < boot.lenses.length; i++) {
      if (boot.lenses[i].id === state.lens) return boot.lenses[i];
    }
    return null;
  }

  function radiusActive() {
    var lens = currentLens();
    return !!(lens && lens.tool === 'radius');
  }

  function activeTypes() {
    return RECORD_LAYERS.filter(function (l) { return state.layers.has(l); })
      .map(function (l) { return boot.layerType[l]; });
  }

  function layerOfType(type) {
    for (var i = 0; i < RECORD_LAYERS.length; i++) {
      if (boot.layerType[RECORD_LAYERS[i]] === type) return RECORD_LAYERS[i];
    }
    return null;
  }

  function windowPhrase() {
    if (state.days === 0) return 'all time';
    if (state.days === 365) return 'the last year';
    return 'the last ' + state.days + ' days';
  }

  // The query string that reproduces the current view. Mirrors
  // viewQuery() in src/records.js.
  function viewQuery(lensOverride) {
    var lens = lensOverride || state.lens;
    var parts = [];
    if (lens === 'custom') {
      var order = ['plants', 'supply'].concat(RECORD_LAYERS);
      parts.push('layers=' + order.filter(function (l) { return l === 'plants' || state.layers.has(l); }).join(','));
    } else {
      parts.push('lens=' + lens);
    }
    if (state.days !== boot.defaultDays) parts.push('days=' + state.days);
    return parts.join('&');
  }

  var PIN_CLASS = { event: 'pin-event', dispersal: 'pin-dispersal', recall: 'pin-recall' };

  function kindTag(r) {
    if (r.type === 'recall') {
      var cls = r.kind === 'Class I' ? 'class-i' : r.kind === 'Class II' ? 'class-ii'
        : r.kind === 'Class III' ? 'class-iii' : '';
      return '<span class="class-tag ' + cls + '">' + esc(r.kind === 'Recall' ? 'Recall' : 'Recall · ' + r.kind) + '</span>';
    }
    if (r.type === 'dispersal') return '<span class="news-kind kind-dispersal">Dispersal</span>';
    return '<span class="news-kind news-' + esc(r.kind) + '">' + esc(r.kind) + '</span>';
  }

  function whereLine(r) {
    var bits = [];
    var town = [r.city, r.state].filter(Boolean).join(', ');
    if (r.type === 'recall') {
      if (r.plant_code) {
        if (r.firm && r.firm !== r.plant_name) bits.push('Recalled by ' + esc(r.firm));
      } else {
        bits.push('Plant not yet identified');
      }
      if (town) bits.push(esc(town));
      if (r.product_count > 1) bits.push(esc(r.product_count) + ' products');
    } else {
      if (r.firm && r.type === 'event') bits.push(esc(r.firm));
      if (r.type === 'dispersal' && r.county) bits.push(esc(r.county) + ' County');
      if (town) bits.push(esc(town));
    }
    return bits.join(' <span class="sep">·</span> ');
  }

  function linksLine(r) {
    var bits = [];
    if (r.plant_code) {
      bits.push('<a href="/plant/' + encodeURIComponent(r.plant_code) + '">Plant page</a>');
    }
    var src = safeUrl(r.source_url);
    if (src) {
      bits.push('<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">Source: ' +
        esc(r.source_name || 'link') + '</a>');
    } else if (r.type === 'recall') {
      var q = r.firm ? '&firm=' + encodeURIComponent(r.firm) : '';
      bits.push('<a href="/timeline?kind=recalls' + q + '">Recall detail</a>');
    }
    return bits.join(' <span class="sep">·</span> ');
  }

  // ---------- map ----------

  var map = null;
  var plantsLayer = null;
  var supplyLayer = null;
  var recordLayers = {};          // layer name -> L.LayerGroup
  var markerByRecord = {};        // record id -> marker
  var radiusCircle = null;

  function icon(cls, size) {
    return L.divIcon({
      className: 'pin-wrap',
      html: '<span class="pin ' + cls + '"></span>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  }

  function initMap() {
    if (typeof L === 'undefined') {
      mapEl.insertAdjacentHTML('beforeend',
        '<div class="map-empty">The map library could not load. The list on this page still works.</div>');
      return;
    }
    map = L.map(mapEl).setView([39.5, -98.35], 4);
    var street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 18,
    });
    var satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Imagery &copy; Esri', maxZoom: 18 }
    );
    street.addTo(map);
    L.control.layers({ 'Street': street, 'Satellite': satellite }, null,
      { collapsed: true, position: 'topright' }).addTo(map);

    plantsLayer = typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 })
      : L.layerGroup();
    supplyLayer = L.layerGroup();
    RECORD_LAYERS.forEach(function (name) { recordLayers[name] = L.layerGroup(); });

    map.on('click', function (e) {
      if (!radiusActive()) return;
      state.radiusCenter = e.latlng;
      drawRadius();
    });
  }

  var KIND_NAMES = { btu: 'bulk tank unit', receiving: 'receiving station', transfer: 'transfer station' };

  function plantPopup(p) {
    var loc = esc([p.city, p.state].filter(Boolean).join(', '));
    var codes = p.codes || [];
    var head = '<strong>' + esc(p.name) + '</strong><br><span class="muted">' + loc + '</span>';
    var body = '<ul class="popup-list">' + codes.map(function (c) {
      var tag = c.category || KIND_NAMES[c.kind] || '';
      var cat = tag ? ' <em class="muted">· ' + esc(tag) + '</em>' : '';
      return '<li><a href="/plant/' + encodeURIComponent(c.plant_code) + '"><code>' +
        esc(c.plant_code) + '</code></a>' + cat + '</li>';
    }).join('') + '</ul>';
    return head + body;
  }

  function renderPlants() {
    if (!map) return;
    plantsLayer.clearLayers();
    supplyLayer.clearLayers();
    var plantIcon = icon('pin-plant', 12);
    var supplyIcon = icon('pin-supply', 10);
    facilities.forEach(function (p) {
      var m = L.marker([p.lat, p.lon], { icon: plantIcon, title: p.name, alt: 'Plant: ' + p.name });
      m.bindPopup(plantPopup(p));
      plantsLayer.addLayer(m);
    });
    supplySites.forEach(function (p) {
      var m = L.marker([p.lat, p.lon], { icon: supplyIcon, title: p.name, alt: 'Milk supply listing: ' + p.name });
      m.bindPopup(plantPopup(p));
      supplyLayer.addLayer(m);
    });
    if (!facilities.length) {
      mapEl.insertAdjacentHTML('beforeend',
        '<div class="map-empty">No plants geocoded yet. Run <code>geocode</code> on the admin endpoint.</div>');
    }
  }

  function recordPopup(group) {
    var shown = group.slice(0, 5);
    var html = shown.map(function (r) {
      var links = linksLine(r);
      return '<div class="popup-record">' +
        '<div class="popup-meta">' + kindTag(r) + ' <span class="muted">' + esc(fmtDate(r.date)) + '</span></div>' +
        '<strong>' + esc(r.title) + '</strong>' +
        (r.summary ? '<p>' + esc(r.summary) + '</p>' : '') +
        (r.located_by === 'city' ? '<p class="muted">Pinned at the town centre, not the exact site.</p>' : '') +
        (links ? '<p class="popup-links">' + links + '</p>' : '') +
        '</div>';
    }).join('');
    if (group.length > shown.length) {
      html += '<p class="muted">and ' + (group.length - shown.length) + ' more here. See the list.</p>';
    }
    return html;
  }

  // One pin per (layer, spot). Several records at the same plant share a
  // pin and are listed in its popup, so pins never stack invisibly.
  function renderPins() {
    if (!map) return;
    markerByRecord = {};
    RECORD_LAYERS.forEach(function (name) {
      var type = boot.layerType[name];
      var layer = recordLayers[name];
      layer.clearLayers();
      var spots = {};
      records.forEach(function (r) {
        if (r.type !== type || r.lat == null || r.lon == null) return;
        var k = r.lat.toFixed(4) + '|' + r.lon.toFixed(4);
        (spots[k] = spots[k] || []).push(r);
      });
      Object.keys(spots).forEach(function (k) {
        var group = spots[k];
        var first = group[0];
        var label = group.length > 1 ? group.length + ' records: ' + first.title : first.title;
        var m = L.marker([first.lat, first.lon], {
          icon: icon(PIN_CLASS[type], 18), title: label, alt: label, zIndexOffset: 500,
        });
        m.bindPopup(recordPopup(group), { maxWidth: 320 });
        layer.addLayer(m);
        group.forEach(function (r) { markerByRecord[r.id] = m; });
      });
    });
  }

  function applyLayers() {
    if (!map) return;
    var want = function (layer, on) {
      if (on && !map.hasLayer(layer)) map.addLayer(layer);
      if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    };
    want(plantsLayer, state.layers.has('plants'));
    want(supplyLayer, state.layers.has('supply'));
    RECORD_LAYERS.forEach(function (name) { want(recordLayers[name], state.layers.has(name)); });
    mapEl.classList.toggle('is-picking', radiusActive());
    drawRadius();
  }

  function focusRecord(id) {
    var m = markerByRecord[id];
    if (!map || !m) return;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 8));
    m.openPopup();
    mapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- "plants within reach" (the buyers lens) ----------

  function milesBetween(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function drawRadius() {
    if (!map) return;
    if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
    if (!radiusActive() || !state.radiusCenter) return;
    var c = state.radiusCenter;
    radiusCircle = L.circle(c, {
      radius: state.radiusMiles * METERS_PER_MILE,
      color: '#2f5d3a', weight: 2, fillColor: '#2f5d3a', fillOpacity: 0.08, interactive: false,
    }).addTo(map);
    renderRadiusResult();
  }

  function renderRadiusResult() {
    var c = state.radiusCenter;
    if (!c) { els.radiusResult.innerHTML = ''; return; }
    var inside = facilities.map(function (p) {
      return { p: p, miles: milesBetween(c.lat, c.lng, p.lat, p.lon) };
    }).filter(function (x) { return x.miles <= state.radiusMiles; })
      .sort(function (a, b) { return a.miles - b.miles; });

    els.radiusHint.textContent = 'Click another spot to move the ring.';
    if (!inside.length) {
      els.radiusResult.innerHTML = '<p class="atlas-empty">No plants in the atlas within ' +
        state.radiusMiles + ' miles of that spot.</p>';
      return;
    }
    var operators = {};
    inside.forEach(function (x) {
      operators[String(x.p.parent || x.p.name || '').trim().toLowerCase()] = true;
    });
    var nOps = Object.keys(operators).length;
    var html = '<p class="radius-count"><strong>' + inside.length + '</strong> ' +
      (inside.length === 1 ? 'plant' : 'plants') + ' run by <strong>' + nOps + '</strong> ' +
      (nOps === 1 ? 'operator' : 'operators') + ' within ' + state.radiusMiles + ' miles.</p>';
    html += '<ol class="radius-list">' + inside.slice(0, NEAREST_LIMIT).map(function (x) {
      var p = x.p;
      var code = p.codes && p.codes[0] ? p.codes[0].plant_code : null;
      var name = code
        ? '<a href="/plant/' + encodeURIComponent(code) + '">' + esc(p.name) + '</a>'
        : esc(p.name);
      var town = esc([p.city, p.state].filter(Boolean).join(', '));
      return '<li><span>' + name + '<br><span class="muted">' + town + '</span></span>' +
        '<span class="radius-miles">' + Math.round(x.miles) + ' mi</span></li>';
    }).join('') + '</ol>';
    if (inside.length > NEAREST_LIMIT) {
      html += '<p class="muted">Nearest ' + NEAREST_LIMIT + ' of ' + inside.length + ' shown.</p>';
    }
    els.radiusResult.innerHTML = html;
  }

  // ---------- "what changed" panel ----------

  function feedItem(r) {
    var mapped = r.lat != null && r.lon != null;
    var title = mapped
      ? '<button type="button" class="atlas-feed-focus" data-id="' + esc(r.id) + '" title="Show on the map">' + esc(r.title) + '</button>'
      : esc(r.title);
    var where = whereLine(r);
    if (!mapped) where += (where ? ' <span class="sep">·</span> ' : '') + '<span class="muted">not on the map</span>';
    var links = linksLine(r);
    return '<li class="atlas-feed-item">' +
      '<span class="pin ' + PIN_CLASS[r.type] + '" aria-hidden="true"></span>' +
      '<div class="atlas-feed-body">' +
      '<div class="atlas-feed-meta">' + kindTag(r) +
      ' <time datetime="' + esc(r.date) + '">' + esc(fmtDate(r.date)) + '</time></div>' +
      '<h3>' + title + '</h3>' +
      (where ? '<p class="atlas-feed-where">' + where + '</p>' : '') +
      (links ? '<p class="atlas-feed-links">' + links + '</p>' : '') +
      '</div></li>';
  }

  function renderFeed() {
    var radius = radiusActive();
    els.radius.hidden = !radius;
    els.feed.hidden = radius;
    if (radius) return;

    var types = activeTypes();
    els.rss.href = '/feed.xml' + (types.length && types.length < RECORD_LAYERS.length ? '?types=' + types.join(',') : '');

    var showEmpty = function (msg) {
      els.feedList.innerHTML = '';
      els.feedNote.textContent = '';
      els.feedEmpty.textContent = msg;
      els.feedEmpty.hidden = false;
    };
    if (recordsError) return showEmpty('The feed could not load (' + recordsError + '). Reload the page to try again.');
    if (!recordsLoaded) return showEmpty('Loading…');
    if (!types.length) return showEmpty('Plants only. Turn on a layer to see what changed.');

    var shown = records.filter(function (r) { return types.indexOf(r.type) !== -1; });
    if (!shown.length) {
      if (types.length === 1 && types[0] === 'dispersal') {
        return showEmpty('No herd dispersal listings in ' + windowPhrase() +
          '. Listings appear here as they are added to the atlas.');
      }
      return showEmpty('Nothing in ' + windowPhrase() + '. Try a longer window.');
    }
    els.feedEmpty.hidden = true;
    els.feedNote.textContent = shown.length > FEED_LIMIT
      ? 'Newest ' + FEED_LIMIT + ' of ' + shown.length
      : shown.length + ' in ' + windowPhrase();
    els.feedList.innerHTML = shown.slice(0, FEED_LIMIT).map(feedItem).join('');
  }

  // ---------- controls ----------

  function renderControls() {
    var lens = currentLens();
    els.lensBtns.forEach(function (a) {
      var id = a.getAttribute('data-lens');
      var on = id === state.lens;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.setAttribute('href', '/map?' + viewQuery(id));
    });
    els.layerBar.hidden = state.lens !== 'custom';
    els.layerBoxes.forEach(function (box) {
      box.checked = state.layers.has(box.getAttribute('data-layer'));
    });
    els.cardTitle.textContent = lens ? lens.label : 'Custom view';
    els.cardBlurb.textContent = lens ? lens.blurb : 'Plants, plus whichever layers you turn on.';
    Array.prototype.forEach.call(els.key.querySelectorAll('li[data-key]'), function (li) {
      li.hidden = !state.layers.has(li.getAttribute('data-key'));
    });
    document.title = (lens ? lens.label : 'Map: custom layers') + ' · Dairy Plant Atlas';
  }

  function syncUrl() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '/map?' + viewQuery());
    }
  }

  function applyView() {
    renderControls();
    applyLayers();
    renderFeed();
    syncUrl();
  }

  function setLens(id) {
    if (id === 'custom') {
      // Start from whatever the current question had on, never from blank.
      state.lens = 'custom';
    } else {
      var lens = null;
      boot.lenses.forEach(function (l) { if (l.id === id) lens = l; });
      if (!lens) return;
      state.lens = id;
      state.layers = new Set(lens.layers);
    }
    applyView();
  }

  els.lensBtns.forEach(function (a) {
    a.addEventListener('click', function (e) {
      // Let modified clicks (new tab, new window) behave like links.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      setLens(a.getAttribute('data-lens'));
    });
  });

  els.layerBoxes.forEach(function (box) {
    box.addEventListener('change', function () {
      var name = box.getAttribute('data-layer');
      if (box.checked) state.layers.add(name); else state.layers.delete(name);
      applyView();
    });
  });

  els.days.addEventListener('change', function () {
    state.days = Number(els.days.value);
    applyView();
    loadRecords();
  });

  els.radiusMiles.addEventListener('change', function () {
    state.radiusMiles = Number(els.radiusMiles.value);
    drawRadius();
  });

  els.feedList.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.atlas-feed-focus') : null;
    if (btn) focusRecord(btn.getAttribute('data-id'));
  });

  els.copy.addEventListener('click', function () {
    var url = window.location.href;
    var done = function (ok) {
      els.copy.textContent = ok ? 'Link copied' : 'Copy failed. Copy it from the address bar';
      setTimeout(function () { els.copy.textContent = 'Copy link to this view'; }, 2500);
    };
    var fallback = function () {
      try {
        var t = document.createElement('input');
        t.value = url;
        document.body.appendChild(t);
        t.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(t);
        done(ok);
      } catch (err) { done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  });

  // ---------- data ----------

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function loadPlants() {
    return getJson('/api/plants/geo.json').then(function (data) {
      // Older servers send no kind; treat those groups as plants.
      var all = data.plants || [];
      facilities = all.filter(function (p) { return p.kind !== 'supply'; });
      supplySites = all.filter(function (p) { return p.kind === 'supply'; });
      renderPlants();
      if (state.radiusCenter) renderRadiusResult();
    }).catch(function (e) {
      mapEl.insertAdjacentHTML('beforeend',
        '<div class="map-empty">Plants could not load: ' + esc(e && e.message || e) + '</div>');
    });
  }

  var recordsRequest = 0;
  function loadRecords() {
    var mine = ++recordsRequest;
    recordsLoaded = false;
    recordsError = null;
    renderFeed();
    return getJson('/api/records.json?days=' + state.days).then(function (data) {
      if (mine !== recordsRequest) return;   // a newer window was picked meanwhile
      records = data.records || [];
      recordsLoaded = true;
      renderPins();
      renderFeed();
    }).catch(function (e) {
      if (mine !== recordsRequest) return;
      records = [];
      recordsLoaded = true;
      recordsError = String(e && e.message || e);
      renderPins();
      renderFeed();
    });
  }

  initMap();
  applyView();
  loadPlants();
  loadRecords();
})();

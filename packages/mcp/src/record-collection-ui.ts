/** Shared presentation for comparable, read-only records inside the widget. */
export const RECORD_COLLECTION_STYLES = String.raw`
    .collection-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.65rem 1rem; margin:.35rem 0 .85rem }
    .collection-heading .operation-heading { margin:0 }
    .collection-filter { min-width:0; width:12rem; max-width:100%; padding:.45rem .65rem; border:1px solid var(--line); border-radius:.5rem; background:var(--soft); color:var(--ink); font:inherit; font-size:.8rem }
    .collection-filter::placeholder { color:var(--muted) }
    .collection-filter:focus-visible,.collection-scroll:focus-visible { outline:2px solid var(--orange); outline-offset:2px }
    .collection-scroll { overflow:auto; max-height:24rem; scrollbar-width:thin; border:1px solid var(--line); border-radius:.65rem }
    .collection-scroll .workflow-table { font-size:.8125rem; line-height:1.4; font-variant-numeric:tabular-nums }
    .collection-scroll .workflow-table :is(td,th) { padding:.48rem .7rem }
    .collection-scroll .workflow-table thead th { background:var(--soft); font-size:.75rem; font-weight:600 }
    .collection-scroll .workflow-table tbody th { font-weight:600 }
    .collection-scroll .workflow-table tbody tr:last-child > * { border-bottom:0 }
    .collection-scroll .workflow-table tr[hidden] { display:none }
    @media (pointer:coarse) { .collection-filter { min-height:44px; font-size:1rem } }
    @media (max-width:480px) {
      .collection-filter { flex:1 1 9rem }
      .collection-scroll .workflow-table:not(.workflow-stack) :is(td,th) { padding:.45rem .5rem }
      .collection-scroll .workflow-stack tbody :is(td,th) { padding:.2rem .65rem }
      .collection-scroll .workflow-stack tbody th { display:block }
      .collection-scroll .workflow-stack tbody th .workflow-cell-label { display:none }
    }
`;

export const RECORD_COLLECTION_UI = String.raw`
    function recordLabel(path) {
      const words = human(path.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2')).toLowerCase();
      return human(words).replace(/\b(?:id|url|sku|iso)\b/gi, word => word.toUpperCase());
    }

    function recordLeaf(path) { return recordLabel(path.split('.').at(-1)).toLowerCase(); }

    function recordVisibleFields(row) {
      return dataFields(row).filter(({label}) =>
        !/(?:hash|token|secret|password|authorization|credential|pending operation|snapshot|resource receipt|preview url|preview cover url|logo url|pixel code)/i.test(label) &&
        !/^(?:notes?|actions)$/i.test(label));
    }

    const recordRank = {name:0, qualifiedName:1, value:2, code:3, other:4, id:5, resource:6};
    function recordFieldPriority(path) {
      const leaf = recordLeaf(path);
      if (/^(?:name|display name|descriptive name|title|label|search term|keyword(?: text)?)$/.test(leaf) ||
          (leaf === 'text' && /keyword/i.test(path))) return recordRank.name;
      if (leaf === 'resource name') return recordRank.resource;
      if (/ name$/.test(leaf)) return recordRank.qualifiedName;
      if (leaf === 'value') return recordRank.value;
      if (/(?:^| )code$/.test(leaf)) return recordRank.code;
      if (/(?:^| )id$/.test(leaf)) return recordRank.id;
      return recordRank.other;
    }

    // Use the shortest unambiguous suffix, e.g. "Name" or "Campaign name" and "Ad group name".
    function recordColumnLabels(paths) {
      const parts = paths.map(path => path.split('.'));
      return new Map(paths.map((path, i) => {
        let depth = 1;
        const label = () => recordLabel(parts[i].slice(-depth).join(' '));
        while (depth < parts[i].length && parts.some((other, j) =>
          i !== j && recordLabel(other.slice(-depth).join(' ')) === label())) depth++;
        return [path, label()];
      }));
    }

    function recordCollection(rows, meta, total) {
      // A provider cursor may return a different projection on the next page.
      // Its incremental cards keep their identity, focus and scroll position.
      if (!rows.length || (rows.length === 1 && meta.tool !== 'google_gaql') || meta.pagination) return null;
      const columns = new Map(), values = [];
      for (const row of rows) {
        if (!object(row) || (row.provider && row.provider !== meta.provider) || (providerSvg[row.platform] && row.platform !== meta.provider)) return null;
        const fields = recordVisibleFields(row);
        if (!fields.length || fields.some(field => Array.isArray(field.after))) return null;
        const cells = new Map();
        for (const {path, after} of fields) {
          if (path === 'provider' && after === meta.provider) continue;
          cells.set(path, after);
          columns.set(path, (columns.get(path) || 0) + 1);
        }
        if (columns.size > 12) return null;
        values.push(cells);
      }
      let paths = [...columns.keys()];
      const shared = paths.filter(path => columns.get(path) === rows.length);
      if (!shared.length || (shared.length * 2 < paths.length && !shared.some(path => recordFieldPriority(path) <= recordRank.value))) return null;
      const root = paths[0].split('.')[0];
      const oneResource = paths.every(path => path.startsWith(root + '.'));
      const geo = oneResource && recordLabel(root) === 'Geo target constant';
      const language = oneResource && recordLabel(root) === 'Language constant';
      const types = paths.filter(path => /^(?:target type|type)$/.test(recordLeaf(path)));
      const type = types.length === 1 ? types[0] : null;
      const kind = type && values[0].get(type);
      const sameType = typeof kind === 'string' && kind.trim() && rows.length === total && values.every(row => row.get(type) === kind);
      const countries = geo && sameType && type.split('.').length === 2 && recordLeaf(type) === 'target type' && kind.toLowerCase() === 'country';
      const summarizeType = sameType && paths.length > 1 && (countries || rows.length > 1);
      // Google also returns a resource name for some queries. Omit it only when
      // it is the same prefix plus the exact ID that is already visible.
      paths = paths.filter(path => {
        if (summarizeType && path === type) return false;
        if (recordLeaf(path) !== 'resource name') return true;
        const id = paths.find(other => other.split('.').slice(0,-1).join('.') === path.split('.').slice(0,-1).join('.') && recordLeaf(other) === 'id');
        if (!id) return true;
        const first = String(values[0].get(path) ?? ''), prefix = first.slice(0, first.lastIndexOf('/') + 1);
        return !prefix || !values.every(row => row.get(id) != null && row.get(path) === prefix + row.get(id));
      });
      if (!paths.length) return null;
      paths.sort((a,b) => recordFieldPriority(a) - recordFieldPriority(b));
      const distinct = new Map(paths.map(path => [path, new Set(values.map(row => row.get(path)).filter(value => value != null && value !== '')).size]));
      const names = paths.filter(path => recordFieldPriority(path) <= recordRank.value);
      const identifiers = paths.filter(path => recordFieldPriority(path) !== recordRank.other && recordLeaf(path) !== 'currency code');
      // Display a distinguishing name first. A repeated name can still sit beside its unique ID.
      const primary = names.find(path => distinct.get(path) === rows.length) ||
        names.find(path => distinct.get(path) > 1 && values.every(row => row.get(path) != null && row.get(path) !== '')) ||
        identifiers.find(path => distinct.get(path) === rows.length) ||
        identifiers.find(path => distinct.get(path) > 1) || names.find(path => distinct.get(path)) || paths[0];
      paths = [primary, ...paths.filter(path => path !== primary)];
      const labels = recordColumnLabels(paths);
      let title;
      if (geo || language) {
        title = countries ? 'Countries' : geo ? 'Target locations' : 'Languages';
        for (const path of paths) {
          if (path.split('.').length !== 2) continue;
          const leaf = recordLeaf(path);
          if (leaf === 'name') labels.set(path, countries ? 'Country' : geo ? 'Location' : 'Language');
          if (geo && leaf === 'id') labels.set(path,'Target ID');
          if (geo && leaf === 'target type') labels.set(path,'Type');
        }
      } else if (oneResource && meta.tool === 'google_gaql') {
        title = recordLabel(root).replace(/ (?:constant|view)$/i,'') + ' results';
      }
      const subject = summarizeType && !countries ? 'Type · ' + kind : '';
      return {paths, labels, values, title, subject};
    }

    function recordCollectionTable(collection, meta, title) {
      const {paths, labels, values} = collection;
      const scales = paths.map(recordAmountScale);
      const headers = paths.map((path,i) => scales[i] ? labels.get(path).replace(/ (?:micros|cents)$/i,'') : labels.get(path));
      const currencyPaths = paths.filter(recordCurrencyField);
      const rows = values.map(cells => {
        const currency = recordCurrency(currencyPaths.map(path => cells.get(path)),meta);
        return '<tr role="row">' + paths.map((path,i) => {
          const value = cells.get(path);
          return workflowCell(headers[i], value == null || value === '' ? '—' : recordValue(value,path,currency,scales[i]), i === 0);
        }).join('') + '</tr>';
      });
      return '<div class="collection-scroll" role="region" aria-label="Returned records" tabindex="0"><table class="workflow-table' +
        (paths.length > 3 ? ' workflow-stack' : '') + '" role="table" aria-label="' + esc(title) + '">' + workflowHeader(headers) +
        '<tbody id="record-collection-rows" role="rowgroup">' + rows.join('') + '</tbody></table></div>';
    }

    function renderRecordCollection(data, meta, collection, title, scope, clean, total) {
      const shown = collection.values.length;
      const count = total + (total === 1 ? ' result' : ' results');
      const search = shown >= 15 ? '<input class="collection-filter" type="search" aria-label="Filter shown results" aria-controls="record-collection-rows" placeholder="Filter results" autocomplete="off">' : '';
      const heading = collection.title || title;
      const subject = [scope,collection.subject].filter(Boolean).join(' · ');
      app.innerHTML = chrome('<div class="collection-heading">' + operationHeader(heading,subject,meta.provider) + search + '</div>' +
        notices(data) + recordCollectionTable(collection,meta,heading) + '<p class="operation-note" data-collection-empty hidden>No matching results.</p>' +
        (shown < total ? workflowNote('Showing ' + shown.toLocaleString() + ' of ' + total.toLocaleString() + ' results. The full response is in Details.') : '') +
        '<details><summary>Details</summary><pre>' + esc(JSON.stringify(clean,null,2)) + '</pre></details>',count);
      if (!search) return;
      const input = app.querySelector('.collection-filter'), context = app.querySelector('.context'), empty = app.querySelector('[data-collection-empty]');
      const original = context.textContent;
      const entries = [...app.querySelectorAll('#record-collection-rows tr')].map(node => ({
        node, text: [...node.cells].map(cell => cell.textContent).join(' ').toLowerCase()
      }));
      context.setAttribute('role','status');
      function filter() {
        const query = input.value.trim().toLowerCase();
        let matched = 0;
        for (const {node,text} of entries) {
          node.hidden = !text.includes(query);
          if (!node.hidden) matched++;
        }
        empty.hidden = matched !== 0;
        context.textContent = query ? (syntheticResult ? 'Synthetic demo · ' : '') + matched + ' of ' + shown + ' shown' : original;
      }
      input.addEventListener('input',filter);
      input.addEventListener('keydown',event => {
        if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; filter(); }
      });
    }
`;

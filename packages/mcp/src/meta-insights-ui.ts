/** The Meta Insights projection can contain entity fields, breakdowns, or just metrics. */
export const META_INSIGHTS_UI = String.raw`
    const metaBreakdownLabels = {
      publisher_platform:'Platform', platform_position:'Placement', impression_device:'Impression device', device_platform:'Device platform',
      age:'Age', gender:'Gender', country:'Country', region:'Region', dma:'DMA', zip:'ZIP', product_id:'Product ID',
      hourly_stats_aggregated_by_advertiser_time_zone:'Hour (ad account)', hourly_stats_aggregated_by_audience_time_zone:'Hour (audience)',
      image_asset:'Image', video_asset:'Video', title_asset:'Headline', body_asset:'Ad text', ad_format_asset:'Ad format',
      objective:'Objective', buying_type:'Buying type', attribution_setting:'Attribution setting'
    };
    function metaBreakdownKeys(payload) {
      return [...new Set([...arr(payload?.breakdowns).filter(key => typeof key === 'string'), ...Object.keys(metaBreakdownLabels)])];
    }
    function metaBreakdownValue(key, value) {
      if (object(value)) return workflowText(value.name || value.text || value.title || value.id || value.hash);
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      const text = workflowText(value);
      return ['publisher_platform','platform_position','impression_device','device_platform','gender'].includes(key) ? human(text) : text;
    }
    function metaEntityValues(rows, level) {
      const names = rows.map(row => workflowText(row[level + '_name'])), ids = rows.map(row => workflowText(row[level + '_id']));
      const byName = new Map();
      names.forEach((name, i) => {
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(ids[i]);
      });
      return names.map((name, i) => name && ids[i] && byName.get(name).size > 1 ? name + ' (' + ids[i] + ')' : name || ids[i]);
    }
    function metaMetricLabel(key) {
      const [kind, action] = key.split(' · ');
      if (!action) return nativeReportLabel(key);
      const event = action.replaceAll('_', ' ');
      if (kind === 'actions' && /(?:^|_)(?:purchase|lead|install|click|registration)$/.test(action)) return human(event) + 's';
      if (kind === 'action_values') return human(event) + ' value';
      if (kind === 'cost_per_action_type') return 'Cost per ' + event;
      if (kind === 'purchase_roas') return human(event) + ' ROAS';
      return nativeReportLabel(key);
    }

    function metaInsightsReport(records, points, payload) {
      const rows = records.map(record => record?.native || {}), dimensions = [];
      const add = (label, values) => {
        if (values.some(Boolean)) dimensions.push({label, values, shared:values.every(value => value === values[0])});
      };
      for (const [level, label] of [['account','Account'],['campaign','Campaign'],['adset','Ad set'],['ad','Ad']]) {
        add(label, metaEntityValues(rows, level));
      }
      for (const key of metaBreakdownKeys(payload)) {
        if (rows.some(row => Object.hasOwn(row, key))) add(Object.hasOwn(metaBreakdownLabels,key) ? metaBreakdownLabels[key] : recordLabel(key), rows.map(row => metaBreakdownValue(key, row[key])));
      }
      const seriesDimensions = dimensions.filter(dimension => !dimension.shared);
      const locale = state.host.locale || 'en';
      const dates = new Intl.DateTimeFormat(locale, {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
      const periodLabels = new Map();
      const periods = rows.map(row => {
        const start = reportDate(row.date_start), end = reportDate(row.date_stop), key = [start,end].join('/');
        if (!periodLabels.has(key)) {
          const from = start && new Date(start), to = end && new Date(end);
          const period = from && to && from <= to ? dates.formatRange(from, to) :
            from && !to ? 'From ' + dates.format(from) : to && !from ? 'Through ' + dates.format(to) : '';
          periodLabels.set(key, period);
        }
        return periodLabels.get(key);
      });
      add('Period', periods);

      const varying = dimensions.filter(dimension => !dimension.shared), scope = dimensions.filter(dimension => dimension.shared).map(dimension => dimension.values[0]);
      const joined = (columns, i) => columns.map(column => column.values[i] || '—').join(' · ');
      const label = varying.map(dimension => dimension.label).join(' / ');
      const title = varying.length ? 'Performance by ' + varying.map(dimension => dimension.label.toLowerCase()).join(' and ') : 'Meta ad performance';
      const currencies = new Set(records.map(record => record?.currency || ''));
      const numeric = new Intl.NumberFormat(locale, {maximumFractionDigits:2});
      const fieldsByRow = points.map(point => {
        const fields = new Map();
        for (const field of point.fields) {
          const display = field.shortDisplay ?? (field.value === null ? field.display : numeric.format(field.display));
          const suffix = /(?:^|_)ctr$/.test(field.key) ? '%' : field.key.startsWith('purchase_roas · ') ? '×' : '';
          const shortDisplay = display + (field.value !== null ? suffix : '');
          fields.set(field.key, fields.has(field.key) ? {...field, value:null, shortDisplay:'See Details'} :
            {...field, label:metaMetricLabel(field.key), shortDisplay, display:shortDisplay + (field.unit ? ' ' + field.unit : '')});
        }
        return fields;
      });
      const keys = [...new Set(fieldsByRow.flatMap(fields => [...fields.keys()]))];
      const priority = key => /^(?:actions|purchase_roas|cost_per_action_type) · (?:.*[_.])?(?:purchase|lead|install|registration)$/.test(key) ? 5 : reportMetricPriority(key);
      keys.sort((a,b) => priority(a) - priority(b));
      const isMoney = key => nativeReportMoneyField(key, 'meta');
      if (keys.some(isMoney) && currencies.has('')) scope.push('Currency unavailable');
      const subject = scope.join(' · ');
      const view = html => ({title, subject, html});
      if (!keys.length) return view(workflowNote('No metrics were returned for this selection.'));
      if (rows.length > 1 && !varying.length) return view(workflowNote('These rows have no distinguishing labels. Include a campaign, ad set, ad name, or a breakdown such as placement to compare them.'));

      const shown = keys.slice(0,5), currency = currencies.size === 1 && records[0]?.currency;
      const metricHeader = key => metaMetricLabel(key) + (currency && isMoney(key) ? ' · ' + currency : '');
      const cell = (i, key) => {
        const field = fieldsByRow[i].get(key);
        if (!field) return '—';
        return field.shortDisplay + (field.value !== null && isMoney(key) && currencies.size > 1 ? ' ' + (records[i]?.currency || '(unknown currency)') : '');
      };
      const extra = keys.length > shown.length ? workflowNote((keys.length - shown.length) + ' more metrics in Details.') : '';
      if (rows.length === 1) return view('<div class="meta-insight-kpis">' + workflowFields(shown.map(key => [metricHeader(key),cell(0,key)])) + '</div>' + extra);

      const names = rows.map((_,i) => joined(varying,i));
      const distinct = new Set(names).size === rows.length && rows.every((_,i) => varying.some(column => column.values[i]));
      const comparable = periods.every(period => period === periods[0]) && (!isMoney(keys[0]) || (currencies.size === 1 && (currency || new Set(rows.map(row => row.account_id)).size === 1)));
      const ranked = comparable && (keys[0] === 'spend' || keys.length === 1) && fieldsByRow.some(fields => available(fields.get(keys[0])?.value));
      const order = rows.map((_,i) => i);
      if (ranked) order.sort((a,b) => (fieldsByRow[b].get(keys[0])?.value ?? -Infinity) - (fieldsByRow[a].get(keys[0])?.value ?? -Infinity));

      // Only join daily observations of an identified entity or breakdown.
      const series = rows.map((_,i) => joined(seriesDimensions,i) || joined(dimensions.filter(column => column.label !== 'Period'),i));
      const seriesCount = new Set(series).size;
      const trend = keys.length === 1 && distinct && rows.length <= 366 && dimensions.some(column => column.label !== 'Period') &&
        points.every(point => point.date) && new Set(points.map(point => point.date)).size > 1 && seriesCount <= 3 &&
        seriesCount < rows.length && (!isMoney(keys[0]) || currencies.size === 1);
      if (trend || (keys.length === 1 && ranked && distinct && rows.length <= 8)) {
        const pointsForChart = order.map(i => ({name:names[i], series:series[i], date:points[i].date, fields:[fieldsByRow[i].get(keys[0])].filter(Boolean)}));
        const chart = reportCharts(pointsForChart, {metric:keys[0], mode:trend ? undefined : 'bars', label:metaMetricLabel(keys[0]) + (trend ? ' over time' : '')});
        return {...view(chart.html), mount:chart.mount};
      }
      const note = distinct ? '' : workflowNote('Some rows share a label or are missing one. A more specific name, ID, or breakdown can distinguish them.');
      const values = order.slice(0,1000).map(i => [names[i], ...shown.map(key => cell(i,key))]);
      const table = workflowTable([label, ...shown.map(metricHeader)], values, title, {compact:true, sorted:ranked ? 1 : -1});
      const limit = values.length < rows.length ? workflowNote('Showing 1,000 of ' + rows.length.toLocaleString(locale) + ' returned rows. All rows are in Details.') : '';
      return view(note + '<div class="meta-insights-table">' + table + '</div>' + extra + limit);
    }
`;

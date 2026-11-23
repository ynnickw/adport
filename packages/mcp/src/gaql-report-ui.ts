/** Presentation of arbitrary GAQL projections inside the offline report widget. */
export const GAQL_REPORT_UI = String.raw`
    const gaqlEntities = new Map([
      ['searchTermView.searchTerm', 'Search term'], ['campaignSearchTermView.searchTerm', 'Search term'],
      ['adGroupCriterion.keyword.text', 'Keyword'], ['segments.keyword.info.text', 'Keyword'],
      ['adGroupAd.ad.name', 'Ad'], ['adGroupAd.ad.id', 'Ad ID'],
      ['asset.name', 'Asset'], ['asset.id', 'Asset ID'], ['assetGroup.name', 'Asset group'], ['assetGroup.id', 'Asset group ID'],
      ['adGroup.name', 'Ad group'], ['adGroup.id', 'Ad group ID'], ['campaign.name', 'Campaign'], ['campaign.id', 'Campaign ID'],
      ['customer.descriptiveName', 'Account'], ['customer.id', 'Account ID']
    ]);

    function gaqlDimensions(row) {
      const {metrics, ...dimensions} = row;
      return new Map(dataFields(dimensions)
        .filter(({path, after}) => after != null && !Array.isArray(after) && String(after).trim() &&
          !/(?:currency(?:_?code)?$|token|secret|password|authorization)/i.test(path))
        .map(({path, after}) => [path, String(after)]));
    }

    function gaqlDimensionLabel(path) {
      if (gaqlEntities.has(path)) return gaqlEntities.get(path);
      if (path.endsWith('.keyword.matchType') || path.endsWith('.keyword.info.matchType')) return 'Match type';
      return human(human(path.replace(/^segments\./, '')).toLowerCase()).replace(/\bid\b/i, 'ID');
    }

    const gaqlMoneyFormats = new Map();
    function gaqlAmount(amount, currency) {
      const locale = state.host.locale || 'en', key = locale + '/' + (currency || '');
      if (!gaqlMoneyFormats.has(key)) {
        const digits = currency ? new Intl.NumberFormat(locale, {style:'currency', currency}).resolvedOptions().maximumFractionDigits : 2;
        gaqlMoneyFormats.set(key, {
          format: new Intl.NumberFormat(locale, {minimumFractionDigits:digits, maximumFractionDigits:digits}),
          unit: 10 ** -digits
        });
      }
      const {format, unit} = gaqlMoneyFormats.get(key);
      if (Number(amount) !== 0 && Math.abs(Number(amount)) < unit) {
        return Number(amount) < 0 ? '>' + format.format(-unit) : '<' + format.format(unit);
      }
      return format.format(amount);
    }

    function gaqlHasTrend(points, dimensions, paths) {
      // A dated series must refer to the same returned entity and breakdown on every date.
      if (points.length > 366 || new Set(points.map(point => point.date)).size < 2) return false;
      const series = new Map(), observations = new Set();
      const seriesPaths = paths.filter(path => path !== 'segments.date');
      return points.every((point, i) => {
        if (!point.date) return false;
        const identity = JSON.stringify(seriesPaths.map(path => dimensions[i].get(path)));
        const observation = JSON.stringify([point.series, point.date]);
        if (observations.has(observation) || (series.has(point.series) && series.get(point.series) !== identity)) return false;
        observations.add(observation);
        series.set(point.series, identity);
        return true;
      }) && series.size <= 3;
    }

    function gaqlReportTable(records, points) {
      const dimensions = records.map(record => record?.gaqlDimensions || new Map());
      const paths = [...new Set(dimensions.flatMap(row => [...row.keys()]))];
      const fields = [...new Set(points.flatMap(row => row.fields.map(field => field.key)))];
      const first = records[0];
      const commonEntity = first?.gaqlEntity && records.every(row => row?.gaqlEntity === first.gaqlEntity);
      if (points.length <= 8 && fields.length === 1 && commonEntity && !points.some(point => point.date) &&
        new Set(points.map(point => point.name)).size === points.length) return null;
      const monetary = fields.some(key => nativeReportMoneyField(key, 'google'));
      const currencies = new Set(records.map(row => row?.currency || ''));
      if ((!monetary || currencies.size === 1) && gaqlHasTrend(points, dimensions, paths)) return null;

      const varies = path => dimensions.some(row => row.get(path) !== dimensions[0].get(path));
      const varying = paths.filter(varies);
      const identifiers = [...gaqlEntities.keys()].filter(path => varying.includes(path));
      const names = identifiers.filter(path => !path.endsWith('.id'));
      const columns = [...new Set([...names, ...identifiers, ...varying])].filter(path => !path.endsWith('.resourceName'));
      const distinct = keys => new Set(dimensions.map(row => JSON.stringify(keys.map(key => row.get(key))))).size;
      let identities = distinct(columns);
      for (const path of varying.filter(path => path.endsWith('.resourceName'))) {
        const withResource = distinct([...columns, path]);
        if (withResource > identities) { columns.push(path); identities = withResource; }
      }
      const primary = columns.shift() ?? (records.length === 1 ? first?.gaqlEntity : undefined);
      const metrics = fields.sort((a, b) => reportMetricPriority(a) - reportMetricPriority(b));
      const mixed = monetary && currencies.size > 1;
      const currency = currencies.size === 1 ? first?.currency : null;
      const headers = [primary ? gaqlDimensionLabel(primary) : 'Row', ...metrics.map(key =>
        nativeReportLabel(key) + (currency && nativeReportMoneyField(key, 'google') ? ' · ' + currency : '')),
        ...(mixed ? ['Currency'] : []), ...columns.map(gaqlDimensionLabel)];
      const values = points.map((point, i) => [
        primary ? dimensions[i].get(primary) : i + 1,
        ...metrics.map(key => {
          const field = point.fields.find(field => field.key === key);
          return field?.shortDisplay ?? field?.display;
        }),
        ...(mixed ? [records[i]?.currency] : []), ...columns.map(path => dimensions[i].get(path))
      ]);
      const scope = paths.filter(path => path !== primary && !varying.includes(path) &&
        (gaqlEntities.has(path) || path.startsWith('segments.')) &&
        !(path.endsWith('.id') && paths.includes(path.slice(0, -2) + 'name')))
        .map(path => gaqlEntities.has(path) && !path.endsWith('.id') ? dimensions[0].get(path) :
          gaqlDimensionLabel(path) + ' ' + dimensions[0].get(path));
      if (monetary && currencies.has('')) scope.push('Currency unavailable');
      return {
        title: gaqlEntities.has(primary) ? gaqlDimensionLabel(primary).replace(/ ID$/, '') + ' performance' : 'Google Ads query results',
        subject: [...new Set(scope)].join(' · '),
        html: (identities < records.length ?
          workflowNote('Some rows have identical labels. Include a more specific name, ID or segment to distinguish them.') : '') +
          workflowTable(headers, values, 'Google Ads query results')
      };
    }
`;

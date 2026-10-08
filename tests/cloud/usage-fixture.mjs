import { brandFixture } from './brand-fixture.mjs';
export const databaseOne = '12345678-1234-1234-1234-123456789abc';
export const databaseTwo = '12345678-1234-1234-1234-123456789def';
export async function usageFixture() {
  const fixture = await brandFixture(), { state } = fixture, original = state.provider;
  state.usageDenied = false; state.plansDenied = false; state.queries = [];
  state.provider = async request => {
    const url = new URL(request.url), second = url.pathname.includes('/' + 'b'.repeat(32) + '/');
    if (url.pathname.endsWith('/d1/database')) return Response.json({ success: true, result: [
      { uuid: databaseOne, name: '业务数据库' }, ...(!second ? [{ uuid: databaseTwo, name: '审计数据库' }] : []),
    ] });
    if (url.pathname.endsWith('/subscriptions')) {
      if (state.plansDenied) return Response.json({}, { status: 403 });
      const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      return Response.json({ success: true, result: ['workers', 'r2'].map(product => ({ state: 'Paid', current_period_start: start, current_period_end: end,
        rate_plan: { id: product + '_paid', scope: 'account', is_contract: false, externally_managed: false } })) });
    }
    if (url.pathname === '/client/v4/graphql') {
      const body = await request.json(); state.queries.push(body);
      if (state.usageDenied) return Response.json({ data: null, errors: [{ message: 'synthetic provider error must stay private' }] });
      const secondAccount = body.variables.account === 'b'.repeat(32), query = body.query, day = body.variables.end.slice(0, 10);
      let samples;
      if (query.includes('d1StorageAdaptiveGroups')) samples = [
        { dimensions: { databaseId: databaseOne, date: day }, max: { databaseSizeBytes: secondAccount ? 1e9 : 4e9 } },
        ...(!secondAccount ? [{ dimensions: { databaseId: databaseTwo, date: day }, max: { databaseSizeBytes: 2e9 } }] : []),
      ];
      else if (query.includes('kvStorageAdaptiveGroups')) samples = [{ dimensions: { namespaceId: '1'.repeat(32), date: day }, max: { byteCount: 100e6 } }];
      else if (query.includes('workersInvocationsAdaptive')) samples = [{ dimensions: { scriptName: 'existing-worker' }, sum: { requests: 321 } }];
      else if (query.includes('storageClass:"Standard"')) {
        samples = []; const start = Date.parse(body.variables.start), end = Date.parse(body.variables.end);
        for (let time = start; time <= end; time += 86400000) samples.push({ dimensions: { bucketName: 'app-files', date: new Date(time).toISOString().slice(0, 10) }, max: { payloadSize: secondAccount ? 957e6 : 14e9 } });
      } else samples = ['Standard', 'InfrequentAccess'].map(storageClass => ({ dimensions: { bucketName: 'app-files', storageClass, datetime: body.variables.end }, max: { payloadSize: storageClass === 'Standard' ? secondAccount ? 957e6 : 14e9 : 0 } }));
      return Response.json({ data: { viewer: { accounts: [{ samples }] } }, errors: null });
    }
    return original(request);
  };
  return fixture;
}

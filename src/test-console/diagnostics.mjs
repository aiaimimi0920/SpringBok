import { matchesResource, matchesUpdate } from '../execution/plan.mjs';
import { containerMatches } from '../komodo/ci-client.mjs';

// Whitelisted observations only. Never forward raw backend responses or errors.
const messages = {
  'receipt-unknown': ['执行回执未知', '没有可可靠绑定的 Update ID，不能判断远端是否执行。', '保持阻断；不要重新部署或猜测执行 ID，需在接入前设计人工核对流程。'],
  'configuration-unknown': ['配置准备结果未知', '配置写入或读回未得到确认，尚不能安全继续。', '保持阻断；不要重写配置或清空记录。'],
  'recorded-success': ['历史记录已验证成功', '这是已持久记录的执行结果，不是当前容器健康检查。', '无需重复核对该执行；后续操作仍遵守发布契约。'],
  'recorded-failure': ['历史记录已验证失败', '这是已持久记录的失败结果；本次查看不会改变它。', '按当前阶段选择已允许的测试或已知成功版本回滚。'],
  queued: ['执行仍在排队', '确切 Update ID 和目标一致，远端状态仍为 Queued。', '稍后再次查看证据；不要重新提交部署。'],
  running: ['远端执行中', '确切 Update ID 和目标一致，远端状态仍为 InProgress。', '等待执行完成后再核对，切勿重复部署。'],
  'update-mismatch': ['执行证据不匹配', '返回的 ID、操作、目标或状态不能绑定到本次记录。', '保持阻断，核对资源与执行记录；不能将其他执行当成本次结果。'],
  'update-failed': ['远端报告执行失败', '匹配的 Update 已完成，success=false；本次查看尚未写入结果。', '使用“刷新执行证据”重新读取并持久记录结果。'],
  'configuration-drift': ['目标配置未确认', '目标身份或完整配置与提交计划不一致，不能确认本次执行。', '保持阻断，调查配置变化；此处不会自动覆盖配置。'],
  'image-mismatch': ['容器镜像不匹配', '容器不存在或镜像不等于计划中的不可变镜像。', '保持阻断，检查目标容器；不能用其他镜像的健康状态判定成功。'],
  oom: ['容器出现内存不足标记', '容器 OOMKilled=true，不符合成功或固定坏镜像失败的证据要求。', '先调查资源问题；不要把它当作预期退出码 1。'],
  paused: ['容器处于暂停状态', '容器 Paused=true，不能确认运行健康。', '调查容器状态；此处不会自动恢复或重启。'],
  'fixture-failed': ['样例容器明确退出 1', '镜像一致且容器非 OOM、非暂停，符合固定样例失败条件。', '使用“刷新执行证据”重新读取并记录失败；不能晋级。'],
  'health-starting': ['健康检查尚在启动', '镜像一致，容器正在运行，但健康检查状态仍为 starting。', '稍后查看或核对证据，不要重复部署。'],
  'health-unhealthy': ['健康检查未通过', '镜像一致，运行中的容器报告 unhealthy；这不等于已记录失败。', '调查健康检查；此处不读取日志、不重启，也不写入成功。'],
  'health-unconfirmed': ['容器健康证据不足', '容器状态缺失或不符合确切的成功、固定失败条件。', '保持当前记录，取得完整证据后再核对。'],
  'ready-to-record': ['当前观测满足成功核对条件', 'Update、完整配置和容器健康均匹配，但本次查看没有写入结果。', '使用“刷新执行证据”重新验证并持久记录；随后才能按契约继续。'],
  unavailable: ['暂时无法读取证据', '读取失败或超时；没有据此推断成功或失败。', '稍后再次查看；已知执行仅只读核对，不能重发部署。'],
};
export function diagnostic(code) {
  const [title, detail, next] = messages[code]; return { code, title, detail, next };
}
export async function inspectExecution(request, call) {
  if (request.status === 'unknown') return diagnostic('receipt-unknown');
  if (request.status === 'succeeded') return diagnostic('recorded-success');
  if (request.status === 'failed') return diagnostic('recorded-failure');
  if (request.status !== 'accepted' || !request.plan) throw new Error('not an execution record');
  try {
    const update = await call('read/GetUpdate', { id: request.updateId });
    if (!matchesUpdate(update, request.plan, request.updateId)) return diagnostic('update-mismatch');
    if (update.status === 'Queued') return diagnostic('queued');
    if (update.status === 'InProgress') return diagnostic('running');
    if (!update.success) return diagnostic('update-failed');
    const resource = await call('read/GetDeployment', { deployment: request.plan.target });
    let matches = false;
    try { matches = matchesResource(resource, request.plan); } catch { /* malformed configuration stays unconfirmed */ }
    if (!matches) return diagnostic('configuration-drift');
    const container = await call('read/InspectDeploymentContainer', { deployment: request.plan.target });
    if (container?.Image !== request.plan.artifact) return diagnostic('image-mismatch');
    if (container.State?.OOMKilled === true) return diagnostic('oom');
    if (container.State?.Paused === true) return diagnostic('paused');
    if (containerMatches(container, request.plan.artifact, false)) return diagnostic('fixture-failed');
    if (containerMatches(container, request.plan.artifact)) return diagnostic('ready-to-record');
    const state = container.State;
    if (state?.Status === 'running' && state.Running === true && state.OOMKilled === false && state.Paused === false) {
      if (state.Health?.Status === 'starting') return diagnostic('health-starting');
      if (state.Health?.Status === 'unhealthy') return diagnostic('health-unhealthy');
    }
    return diagnostic('health-unconfirmed');
  } catch { return diagnostic('unavailable'); }
}

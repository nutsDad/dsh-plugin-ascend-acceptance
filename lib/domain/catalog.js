/**
 * 昇腾交付核验的领域指标目录。
 *
 * 这是插件的“共同语言”：标准条款和交付证据都先映射到这里的规范指标，再按
 * 类型（数值 / 版本 / 布尔 / 文本 / 文档存在性）比较。目录不追求覆盖所有
 * 厂商术语，而是覆盖昇腾算力集群验收最常出现、且能被机器验证的项；目录之外
 * 的要求会走关键词证据兜底，并在报告里标明置信度。
 *
 * @module dsh-plugin-ascend-acceptance/domain/catalog
 */

export const CATEGORIES = [
  {
    key: 'ascend',
    label: '昇腾运行环境',
    short: '运行环境',
    description: 'NPU、驱动固件、CANN、框架与容器运行时',
    color: '#ff6b4a',
  },
  {
    key: 'datacenter',
    label: '机房基础设施',
    short: '机房',
    description: '供配电、制冷、机柜、承重、消防与安防',
    color: '#22d3ee',
  },
  {
    key: 'cluster',
    label: '集群与网络',
    short: '集群网络',
    description: '节点规模、互联网络、存储、监控与地址规划',
    color: '#a78bfa',
  },
  {
    key: 'docs',
    label: '交付文档',
    short: '文档',
    description: '验收单、装箱单、合格证、测试报告与图纸',
    color: '#fbbf24',
  },
  {
    key: 'ops',
    label: '运维保障',
    short: '运维',
    description: '质保、响应时效、备件、巡检与培训',
    color: '#34d399',
  },
  {
    key: 'other',
    label: '其他要求',
    short: '其他',
    description: '未归入上述类别的条款',
    color: '#94a3b8',
  },
];

export const CATEGORY_MAP = new Map(CATEGORIES.map((category) => [category.key, category]));

const ASCEND_KEYWORDS = [
  '昇腾', 'ascend', 'npu', 'atlas', 'cann', 'hccn', 'hccs', 'hccl', '驱动', '固件',
  'torch_npu', 'torch-npu', 'mindie', 'mindspeed', 'vllm', '910b', '910c', '310p', '显存',
  'ecc', 'npu-smi', '算力卡', '加速卡', 'ai芯片', 'av i', 'vnpu',
];

const DATACENTER_KEYWORDS = [
  '机房', '机柜', 'ups', 'pdu', '市电', '配电', '制冷', '空调', '冷通道', '热通道',
  '温度', '湿度', '接地', '承重', '楼板', '消防', '灭火', '漏水', '门禁', '防雷',
  '柴油发电机', '冷量', '送回风', '静电地板', '抗震', '等电位',
];

const CLUSTER_KEYWORDS = [
  '集群', '节点', '网络', '交换机', '带宽', 'roce', 'rdma', 'infiniband', ' ib ',
  '拓扑', 'ip规划', 'ip地址', 'ntp', 'dns', '监控', 'prometheus', 'grafana', '存储',
  '并行文件系统', '对象存储', '防火墙', '上联', '出口', '灵衢', '参数面', '业务面',
];

const DOCS_KEYWORDS = [
  '文档', '报告', '清单', '合格证', '保修卡', '手册', '图纸', '记录', '方案', '证明',
  '装箱单', '验收单', '资产', '证书', '培训材料', '操作手册', '维护手册', '竣工',
];

const OPS_KEYWORDS = [
  '质保', '保修期', '运维', '响应时间', '到场', '备件', '备品', '巡检', '培训',
  'sla', '驻场', '服务级别', '故障处理', '7×24', '7*24', '服务承诺',
];

/** 判断文本更可能属于哪个类别。 */
export function detectCategory(text = '') {
  const normalized = ` ${normalizeForMatch(text)} `;
  const scores = {
    ascend: countKeywords(normalized, ASCEND_KEYWORDS),
    datacenter: countKeywords(normalized, DATACENTER_KEYWORDS),
    cluster: countKeywords(normalized, CLUSTER_KEYWORDS),
    docs: countKeywords(normalized, DOCS_KEYWORDS),
    ops: countKeywords(normalized, OPS_KEYWORDS),
  };
  let best = 'other';
  let bestScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return { key: best, scores, confidence: bestScore === 0 ? 0 : Math.min(0.95, 0.5 + bestScore * 0.12) };
}

function countKeywords(normalized, keywords) {
  let count = 0;
  for (const keyword of keywords) if (normalized.includes(keyword.toLowerCase())) count += 1;
  return count;
}

/** 统一用于匹配的文本形式：小写、去空白、全角转半角、统一连接符。 */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[（）]/g, (char) => (char === '（' ? '(' : ')'))
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/[／]/g, '/')
    .replace(/[－—–]/g, '-')
    .replace(/[\s_]+/g, '')
    .toLowerCase();
}

/**
 * 指标目录。
 *
 * `aliases` 用于在自然语言中识别指标；`patterns` 用于在同一行里直接抓值。
 * 不要把“温度”“版本”“内存”这类泛词单独放进 aliases：标准和交付件里这两个
 * 词到处出现，泛词会让所有条款都映射到同一个指标。
 */
export const METRICS = [
  // ---------------------------------------------------------------- 昇腾环境
  {
    key: 'npu_model',
    label: 'NPU / 加速卡型号',
    category: 'ascend',
    type: 'string',
    aliases: ['NPU型号', '加速卡型号', 'AI加速卡型号', '算力卡型号', '昇腾型号', 'Atlas型号', '服务器型号', 'NPU卡型号'],
    patterns: [/(?:NPU|加速卡|算力卡|昇腾)(?:型号|产品型号)\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 .-]{2,40})/i],
    evidence: 'npu-smi info 首行设备型号 / 到货装箱单',
    advice: '核对实际到货的 NPU 型号与合同/标准要求是否一致；不一致时提供替换说明或变更审批。',
  },
  {
    key: 'npu_count',
    label: 'NPU 数量',
    category: 'ascend',
    type: 'number',
    unit: '张',
    units: ['张', '卡', '颗', '个'],
    aliases: ['NPU数量', 'NPU卡数', '加速卡数量', '算力卡数量', '昇腾卡数量', 'AI算力卡数量', 'NPU总数'],
    patterns: [
      /(?:NPU|加速卡|算力卡|昇腾卡)(?:数量|总数|卡数)?\s*(?:为|是|达到|共|合计)?\s*[:：=]?\s*(\d{1,4})\s*(?:张|卡|颗|个)/i,
      /(\d{1,4})\s*(?:张|卡|颗)\s*(?:昇腾|NPU|加速卡|算力卡)/i,
    ],
    evidence: 'npu-smi info -l / 设备清单',
    advice: '按合同补齐 NPU 数量，或提供缺货/替代的书面说明并重新验收。',
  },
  {
    key: 'npu_per_node',
    label: '单节点 NPU 数量',
    category: 'ascend',
    type: 'number',
    unit: '张',
    units: ['张', '卡', '颗', '个'],
    aliases: ['单节点NPU数量', '单节点NPU', '单机NPU数量', '单机卡数', '每节点NPU', '单台NPU数量', '单节点加速卡'],
    patterns: [/(?:单节点|单机|每节点|每台)[^，。；;\n]{0,20}?(\d{1,3})\s*(?:张|卡|颗)\s*(?:昇腾|NPU|加速卡|算力卡)?/i],
    evidence: 'npu-smi info -l',
    advice: '确认单节点卡数与设计一致；若为多机拆分交付，请在交付件中说明拓扑。',
  },
  {
    key: 'node_count',
    label: '计算节点数量',
    category: 'cluster',
    type: 'number',
    unit: '台',
    units: ['台', '个', '节点'],
    aliases: ['节点数量', '计算节点数量', '服务器数量', 'GPU服务器数量', 'NPU服务器数量', '训练节点数', '推理节点数'],
    patterns: [/(?:节点|服务器)(?:数量|总数)?\s*(?:为|是|共|合计)?\s*[:：=]?\s*(\d{1,4})\s*(?:台|个|节点)/i],
    evidence: '资产清单 + 集群管理界面',
    advice: '补充节点资产清单与上电/纳管记录，确保节点数与合同一致。',
  },
  {
    key: 'npu_health',
    label: 'NPU 健康状态',
    category: 'ascend',
    type: 'boolean',
    aliases: ['NPU健康状态', '加速卡健康状态', '设备健康状态', 'NPU健康', '芯片健康状态'],
    patterns: [/(?:NPU|加速卡|设备)健康(?:状态)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z]{2,8})/],
    evidence: 'npu-smi info -t health -i <id>',
    advice: '对异常卡执行健康检查与复位；若硬件故障，按备件流程更换并复测。',
  },
  {
    key: 'npu_temp',
    label: 'NPU 温度',
    category: 'ascend',
    type: 'number',
    unit: '℃',
    units: ['℃', '°C', 'C'],
    aliases: ['NPU温度', '芯片温度', 'AI芯片温度', 'NPU结温', '加速卡温度'],
    patterns: [/(?:NPU|芯片|加速卡)温度\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:℃|°C|C)?/i],
    evidence: 'npu-smi info -t temp -i <id>',
    advice: '检查风道、风扇转速与机房冷通道温度；降温后复测并保留 30 分钟稳定值。',
  },
  {
    key: 'npu_power',
    label: 'NPU 功耗',
    category: 'ascend',
    type: 'number',
    unit: 'W',
    units: ['W', '瓦', 'kW'],
    aliases: ['NPU功耗', '单卡功耗', '芯片功耗', '加速卡功耗'],
    patterns: [/(?:NPU|单卡|芯片|加速卡)功耗\s*[:：=]?\s*(\d{1,4}(?:\.\d+)?)\s*(?:W|瓦|kW)?/i],
    evidence: 'npu-smi info -t power -i <id>',
    advice: '核对功耗封顶策略与供电能力；若超限，调整功率上限或补充供电。',
  },
  {
    key: 'npu_memory',
    label: 'NPU 显存',
    category: 'ascend',
    type: 'number',
    unit: 'GB',
    units: ['GB', 'G', 'GiB'],
    aliases: ['NPU显存', '显存容量', 'HBM容量', 'HBM', '单卡显存', '加速卡显存'],
    patterns: [/(?:NPU)?显存(?:容量)?\s*[:：=]?\s*(\d{1,4})\s*(?:GB|G|GiB)/i],
    evidence: 'npu-smi info -t memory -i <id>',
    advice: '核对到货型号的显存规格；若与合同不符，提交型号差异说明。',
  },
  {
    key: 'host_memory',
    label: '主机内存',
    category: 'ascend',
    type: 'number',
    unit: 'GB',
    units: ['GB', 'G', 'GiB', 'TB'],
    aliases: ['主机内存', '系统内存', '内存容量', '服务器内存', '物理内存'],
    patterns: [/(?:主机|系统|服务器|物理)内存(?:容量)?\s*[:：=]?\s*(\d{1,5})\s*(?:GB|G|GiB|TB)/i],
    evidence: 'free -h / dmidecode -t memory',
    advice: '补齐内存至设计容量，并保留 dmidecode 或 BMC 资产信息。',
  },
  {
    key: 'cpu_model',
    label: 'CPU 型号',
    category: 'ascend',
    type: 'string',
    aliases: ['CPU型号', '处理器型号', 'CPU配置', '鲲鹏处理器', '服务器CPU'],
    patterns: [/CPU(?:型号|配置)?\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 .-]{2,48})/i],
    evidence: 'lscpu / BMC 资产信息',
    advice: '提供 lscpu 或 BMC 截图，确认 CPU 型号与合同一致。',
  },
  {
    key: 'ecc_status',
    label: 'ECC 状态',
    category: 'ascend',
    type: 'number',
    unit: '个',
    aliases: ['ECC错误', 'ECC状态', 'ECC计数', 'ECC错误计数', 'ECC告警'],
    patterns: [/ECC(?:错误|计数|告警)?\s*[:：=]?\s*(\d{1,6}|正常|无|0)/i],
    evidence: 'npu-smi info -t ecc -i <id>',
    advice: '清理 ECC 告警并复测；出现不可纠正错误的卡应更换。',
  },
  {
    key: 'driver_version',
    label: 'NPU 驱动版本',
    category: 'ascend',
    type: 'version',
    aliases: ['NPU驱动版本', '驱动版本', 'Ascend驱动版本', 'HDK版本', 'NPU驱动', 'driver版本'],
    patterns: [/(?:NPU|Ascend)?驱动(?:版本|Version)?\s*[:：=]?\s*([A-Za-z0-9._-]{3,32})/i],
    evidence: 'npu-smi info / cat /usr/local/Ascend/driver/version.info',
    advice: '将驱动升级/回退到标准要求版本，升级后重启并复测 NPU 健康状态。',
  },
  {
    key: 'firmware_version',
    label: 'NPU 固件版本',
    category: 'ascend',
    type: 'version',
    aliases: ['NPU固件版本', '固件版本', 'firmware版本', 'MCU版本', 'Bootloader版本'],
    patterns: [/(?:NPU|MCU|Bootloader)?固件(?:版本|Version)?\s*[:：=]?\s*([A-Za-z0-9._-]{3,32})/i],
    evidence: 'npu-smi info -t sysinfo / npu-smi -t version',
    advice: '按兼容矩阵升级固件，升级期间避免业务运行，完成后重新采集版本与健康状态。',
  },
  {
    key: 'cann_version',
    label: 'CANN 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['CANN版本', 'CANN软件版本', 'CANN Toolkit版本', 'CANN', '异构计算架构版本'],
    patterns: [/CANN(?:\s*(?:版本|Version|Ver\.?))?\s*[:：=]?\s*([A-Za-z0-9._-]{2,32})/i, /(?:版本|Version)\s*[:：=]?\s*([0-9]+\.[0-9]+\.[A-Za-z0-9._-]+)\s*(?:CANN)?/i],
    evidence: 'cat /usr/local/Ascend/ascend-toolkit/latest/version.cfg',
    advice: '将 CANN 升级到标准要求的最低版本，并按官方兼容矩阵核对驱动、固件与框架版本。',
  },
  {
    key: 'hccn_status',
    label: 'HCCN / 集合通信状态',
    category: 'ascend',
    type: 'boolean',
    aliases: ['HCCN状态', 'HCCN链路', 'HCCS状态', '集合通信状态', 'HCCL状态', 'HCCN健康'],
    patterns: [/HCCN(?:状态|链路)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z]{2,10})/i],
    evidence: 'hccn_tool -i <id> -link -g / hccn_tool -i <id> -ip -g',
    advice: '逐卡检查 HCCN 链路、IP 与路由；修复后执行 HCCL 集合通信测试（all_reduce 带宽/正确性）。',
  },
  {
    key: 'link_status',
    label: '光模块 / 端口状态',
    category: 'ascend',
    type: 'boolean',
    aliases: ['光模块状态', '端口状态', '链路状态', '光模块告警', 'SerDes状态'],
    patterns: [/(?:光模块|端口|链路)(?:状态|告警)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z]{2,10})/i],
    evidence: 'hccn_tool -i <id> -optical -g / 交换机端口状态',
    advice: '更换告警光模块/线缆，清洁端面后复测误码与链路状态。',
  },
  {
    key: 'os_version',
    label: '操作系统版本',
    category: 'ascend',
    type: 'version',
    aliases: ['操作系统版本', 'OS版本', '操作系统', 'openEuler版本', '麒麟版本', 'Ubuntu版本'],
    patterns: [/(?:操作系统|OS)(?:版本|Version)?\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 ._-]{3,48})/i],
    evidence: 'cat /etc/os-release',
    advice: '重装/升级到标准要求的 OS 与内核组合，并重新验证驱动兼容性。',
  },
  {
    key: 'kernel_version',
    label: '内核版本',
    category: 'ascend',
    type: 'version',
    aliases: ['内核版本', 'kernel版本', 'Linux内核'],
    patterns: [/内核(?:版本)?\s*[:：=]?\s*([0-9][A-Za-z0-9._-]{2,40})/i],
    evidence: 'uname -r',
    advice: '按兼容矩阵调整内核版本，调整后重新验证 NPU 驱动加载。',
  },
  {
    key: 'python_version',
    label: 'Python 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['Python版本', 'Python', '解释器版本'],
    patterns: [/Python(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i],
    evidence: 'python3 --version',
    advice: '安装标准要求的 Python 版本，并用该解释器重建虚拟环境。',
  },
  {
    key: 'pytorch_version',
    label: 'PyTorch 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['PyTorch版本', 'torch版本', 'PyTorch'],
    patterns: [/(?:PyTorch|torch)(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+[A-Za-z0-9]+)?)/i],
    evidence: 'python -c "import torch; print(torch.__version__)"',
    advice: '安装与 CANN/torch_npu 匹配的 PyTorch 版本，并重新跑通最小训练/推理用例。',
  },
  {
    key: 'torch_npu_version',
    label: 'torch_npu 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['torch_npu版本', 'torch-npu版本', 'torch_npu', 'torch-npu'],
    patterns: [/torch[_-]npu(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[A-Za-z0-9]+)?)/i],
    evidence: 'python -c "import torch_npu; print(torch_npu.__version__)"',
    advice: '按 CANN 版本匹配表安装 torch_npu，并验证 torch.npu.is_available() 为 True。',
  },
  {
    key: 'vllm_version',
    label: 'vLLM / vLLM-Ascend 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['vLLM版本', 'vllm-ascend版本', 'vLLM', 'vllm-ascend'],
    patterns: [/vLLM(?:[-\s]?Ascend)?(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[A-Za-z0-9]+)?)/i],
    evidence: 'python -c "import vllm; print(vllm.__version__)" / pip show vllm-ascend',
    advice: '安装标准要求的 vLLM/vLLM-Ascend 版本，并用目标模型跑通一次推理压测。',
  },
  {
    key: 'mindie_version',
    label: 'MindIE 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['MindIE版本', 'MindIE LLM版本', 'MindIE'],
    patterns: [/MindIE(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[A-Za-z0-9]+)?)/i],
    evidence: 'MindIE 服务版本查询接口 / 安装目录 version.info',
    advice: '升级/回退 MindIE 至标准版本，并重新验证模型服务启动与精度。',
  },
  {
    key: 'mindspeed_version',
    label: 'MindSpeed 版本',
    category: 'ascend',
    type: 'version',
    aliases: ['MindSpeed版本', 'MindSpeed-LLM版本', 'MindSpeed'],
    patterns: [/MindSpeed(?:[-\s]?LLM)?(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[A-Za-z0-9]+)?)/i],
    evidence: 'pip show mindspeed / 训练脚本启动日志',
    advice: '安装与 PyTorch/CANN 匹配的 MindSpeed 版本，并复跑基准训练脚本。',
  },
  {
    key: 'docker_version',
    label: 'Docker / 容器运行时',
    category: 'ascend',
    type: 'version',
    aliases: ['Docker版本', '容器运行时版本', 'containerd版本', 'Docker'],
    patterns: [/(?:Docker|containerd)(?:\s*(?:版本|Version))?\s*[:：=]?\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i],
    evidence: 'docker version / containerd --version',
    advice: '升级容器运行时到标准版本，并确认 Ascend Device Plugin 正常注册。',
  },
  {
    key: 'virtualization',
    label: 'vNPU / AVI 虚拟化',
    category: 'ascend',
    type: 'boolean',
    aliases: ['vNPU', 'AVI虚拟化', 'AVI模式', '虚拟化切分', '算力切分'],
    patterns: [/(?:vNPU|AVI)(?:模式|虚拟化|切分)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/i],
    evidence: 'npu-smi info -t avi -i <id>',
    advice: '按标准开启 AVI/vNPU 模式，创建实例并验证容器内可见设备。',
  },
  {
    key: 'npu_smi',
    label: 'npu-smi 可用性',
    category: 'ascend',
    type: 'boolean',
    aliases: ['npu-smi可用', 'npu-smi正常', '设备管理工具', 'npu-smi'],
    patterns: [/npu-smi\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z]{2,8})/i],
    evidence: 'npu-smi info',
    advice: '修复驱动/工具链安装，确保 npu-smi info 可正常输出全部设备。',
  },
  {
    key: 'interconnect',
    label: '集群互联 / 灵衢',
    category: 'cluster',
    type: 'string',
    aliases: ['灵衢', 'UB互联', '参数面网络', 'RDMA网络', 'RoCE网络', 'IB网络', '集群互联', '超节点'],
    patterns: [/(?:灵衢|UB|RoCE|RDMA|IB)(?:网络|互联|组网)?\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 .%/-]{2,48})/i],
    evidence: '组网拓扑图 + 交换机配置 + 带宽测试报告',
    advice: '补齐互联组网与带宽测试证据；若架构与标准不一致，提交设计变更说明。',
  },
  {
    key: 'cluster_scale',
    label: '集群算力规模',
    category: 'cluster',
    type: 'number',
    unit: 'PFLOPS',
    units: ['PFLOPS', 'TFLOPS', 'P', 'T'],
    aliases: ['集群算力', '算力规模', 'AI算力', '集群规模', 'FP16算力'],
    patterns: [/(?:集群|AI)?算力(?:规模)?\s*[:：=]?\s*(\d{1,8}(?:\.\d+)?)\s*(?:PFLOPS|TFLOPS|P|T)/i],
    evidence: '基准测试报告 + 设备清单',
    advice: '提供集群基准测试报告（含测试工具、模型、并行策略与实测值）。',
  },
  {
    key: 'npu_utilization',
    label: 'NPU 利用率',
    category: 'ascend',
    type: 'number',
    unit: '%',
    units: ['%'],
    aliases: ['NPU利用率', '算力利用率', 'AI芯片利用率', 'NPU使用率'],
    patterns: [/(?:NPU|算力|AI芯片)(?:利用率|使用率)\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i],
    evidence: 'npu-smi info / Prometheus NPU exporter',
    advice: '补充稳定运行时段的利用率采样；若持续偏低，排查数据供给与并行效率。',
  },

  // ------------------------------------------------------------------ 机房
  {
    key: 'room_temperature',
    label: '机房 / 冷通道温度',
    category: 'datacenter',
    type: 'number',
    unit: '℃',
    units: ['℃', '°C', 'C'],
    aliases: ['机房温度', '环境温度', '冷通道温度', '机柜进风温度', '进风温度'],
    patterns: [/(?:机房|环境|冷通道|进风|机柜进风)温度\s*[:：=]?\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:℃|°C|C)?/i],
    evidence: '冷通道温湿度计连续 24h 记录 / 动环监控导出',
    advice: '将冷通道温度调整到标准区间；提供连续 24 小时监控曲线，而不是单点截图。',
  },
  {
    key: 'room_humidity',
    label: '机房相对湿度',
    category: 'datacenter',
    type: 'number',
    unit: '%RH',
    units: ['%RH', '%', 'RH'],
    aliases: ['相对湿度', '机房湿度', '环境湿度', '冷通道湿度', '湿度'],
    patterns: [/(?:相对|机房|环境|冷通道)?湿度\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:%RH|%|RH)?/i],
    evidence: '冷通道温湿度计连续 24h 记录 / 动环监控导出',
    advice: '将湿度调整到标准区间，检查加湿/除湿设备与新风比例，并提供连续记录。',
  },
  {
    key: 'rack_u',
    label: '机柜 U 数',
    category: 'datacenter',
    type: 'number',
    unit: 'U',
    units: ['U'],
    aliases: ['机柜U数', '机柜高度', '机柜规格', '42U', '47U', '机柜容量'],
    patterns: [/(?:机柜)?(?:U数|高度|规格)\s*[:：=]?\s*(\d{2})\s*U/i, /(\d{2})\s*U\s*(?:机柜|标准机柜)/i],
    evidence: '机柜铭牌 / 竣工图 / 现场照片',
    advice: '更换或补充满足 U 数要求的机柜，并提供机柜铭牌与竣工图。',
  },
  {
    key: 'rack_count',
    label: '机柜数量',
    category: 'datacenter',
    type: 'number',
    unit: '个',
    units: ['个', '架', '台'],
    aliases: ['机柜数量', '机柜数', '服务器机柜数量', 'IT机柜数量'],
    patterns: [/机柜(?:数量|数)?\s*[:：=]?\s*(\d{1,4})\s*(?:个|架|台)/i],
    evidence: '机房平面图 + 现场清点',
    advice: '补齐机柜数量或提供分期交付说明，并更新机房平面图。',
  },
  {
    key: 'rack_power',
    label: '单机柜功率',
    category: 'datacenter',
    type: 'number',
    unit: 'kW',
    units: ['kW', 'KW', '千瓦', 'W'],
    aliases: ['单机柜功率', '机柜功率', '单柜功率', '每柜功率', '机柜供电能力'],
    patterns: [/(?:单机柜|单柜|每柜|机柜)(?:功率|供电能力)\s*[:：=]?\s*(\d{1,5}(?:\.\d+)?)\s*(?:kW|KW|千瓦|W)?/i],
    evidence: '配电系统图 + PDU 铭牌 + 实测电流',
    advice: '核算单柜实际负载与配电容量；不足时调整机柜分布或扩容配电回路。',
  },
  {
    key: 'it_power',
    label: 'IT / 机房总功率',
    category: 'datacenter',
    type: 'number',
    unit: 'kW',
    units: ['kW', 'KW', 'kVA', '千瓦'],
    aliases: ['IT总功率', '机房总功率', '总供电容量', '供电容量', 'IT负载', '机房功率'],
    patterns: [/(?:IT|机房)?(?:总功率|总容量|供电容量|IT负载)\s*[:：=]?\s*(\d{1,6}(?:\.\d+)?)\s*(?:kW|KW|kVA|千瓦)?/i],
    evidence: '配电系统图 + 容量核算报告',
    advice: '补充配电容量核算，确认总功率与冗余模式下仍满足负载需求。',
  },
  {
    key: 'power_redundancy',
    label: '供电冗余 / 双路市电',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['双路供电', '双路市电', '2N供电', 'N+1供电', '冗余供电', 'UPS供电', '市电接入', '供电方式', '供电'],
    patterns: [/(?:双路|2N|N\+1|冗余)(?:市电|供电|电源)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9+]{1,12})/i],
    evidence: '配电系统图 + A/B 路切换测试记录',
    advice: '完成双路/冗余供电改造，并做一次带载切换测试，保留波形与记录。',
  },
  {
    key: 'ups_backup',
    label: 'UPS 后备时间',
    category: 'datacenter',
    type: 'number',
    unit: '分钟',
    units: ['分钟', 'min', '小时', 'h'],
    aliases: ['UPS后备时间', '后备时间', 'UPS续航', '电池后备时间', 'UPS电池时间'],
    patterns: [/UPS(?:后备|续航|电池)?(?:时间)?\s*[:：=]?\s*(\d{1,4}(?:\.\d+)?)\s*(?:分钟|min|小时|h)?/i],
    evidence: 'UPS 放电测试报告（含负载率与终止电压）',
    advice: '按标准延长后备时间或降低关键负载；提供满载/半载放电测试报告。',
  },
  {
    key: 'pdu',
    label: 'PDU 配置',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['PDU配置', '机柜PDU', '智能PDU', 'PDU数量', '配电单元'],
    patterns: [/PDU(?:配置|数量)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,16})/i],
    evidence: '机柜配电图 + PDU 铭牌/监控截图',
    advice: '按 A/B 路补齐 PDU，并核对每路容量与插接位置。',
  },
  {
    key: 'grounding',
    label: '接地电阻',
    category: 'datacenter',
    type: 'number',
    unit: 'Ω',
    units: ['Ω', '欧姆', 'ohm'],
    aliases: ['接地电阻', '联合接地电阻', '等电位接地电阻', '接地阻值'],
    patterns: [/接地电阻\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:Ω|欧姆|ohm)?/i],
    evidence: '接地电阻测试报告（含测试点、仪器编号、天气）',
    advice: '由具备资质的单位重做接地网/等电位连接，复测到标准值以内并出具报告。',
  },
  {
    key: 'floor_load',
    label: '楼板承重',
    category: 'datacenter',
    type: 'number',
    unit: 'kg/m²',
    units: ['kg/m²', 'kg/m2', 'kN/m²', 'kN/m2', '公斤/平方米'],
    aliases: ['楼板承重', '承重能力', '楼面荷载', '机房承重', '荷载'],
    patterns: [/(?:楼板|楼面|机房)?(?:承重|荷载)\s*[:：=]?\s*(\d{1,5}(?:\.\d+)?)\s*(?:kg\/m²|kg\/m2|kN\/m²|kN\/m2|公斤\/平方米)?/i],
    evidence: '机房结构复核报告 / 承重计算书',
    advice: '对机柜布置做承重复核；必要时分散布置、加固楼板或增加承重架。',
  },
  {
    key: 'cooling',
    label: '制冷能力 / 精密空调',
    category: 'datacenter',
    type: 'number',
    unit: 'kW',
    units: ['kW', 'KW', '匹', 'P'],
    aliases: ['制冷量', '制冷能力', '精密空调', '空调数量', '冷量', '机房空调'],
    patterns: [/(?:制冷量|制冷能力|冷量)\s*[:：=]?\s*(\d{1,5}(?:\.\d+)?)\s*(?:kW|KW|匹|P)?/i],
    evidence: '空调铭牌 + 制冷量核算 + 运行记录',
    advice: '补充制冷量或调整机柜功率密度，确保 N+1 故障时仍能满足热负荷。',
  },
  {
    key: 'cooling_redundancy',
    label: '制冷冗余',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['制冷冗余', '空调冗余', 'N+1空调', '冷冻水冗余', '制冷备份'],
    patterns: [/(?:制冷|空调)(?:冗余|备份|N\+1)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9+]{1,12})/i],
    evidence: '空调系统图 + 单机故障演练记录',
    advice: '按 N+1 配置空调，并做单机停机演练，确认温度不越限。',
  },
  {
    key: 'cold_aisle',
    label: '冷热通道封闭',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['冷热通道', '冷通道封闭', '热通道封闭', '通道封闭', '冷通道', '热通道'],
    patterns: [/(?:冷热通道|冷通道|热通道)[^，。；;]{0,8}(?:封闭|隔离)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})?/i],
    evidence: '机房竣工图 + 现场照片',
    advice: '完成冷热通道封闭/隔离，避免冷热气流短路。',
  },
  {
    key: 'fire_system',
    label: '气体灭火 / 消防',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['气体灭火', '消防系统', '灭火系统', '七氟丙烷', 'IG541', '消防验收', '消防'],
    patterns: [/(?:气体灭火|消防|灭火系统)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,16})/i],
    evidence: '消防验收意见书 + 联动测试记录',
    advice: '完成消防验收与联动测试，补齐验收意见书和钢瓶检测记录。',
  },
  {
    key: 'leak_detection',
    label: '漏水检测',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['漏水检测', '漏水告警', '漏液检测', '水浸检测'],
    patterns: [/(?:漏水|漏液|水浸)(?:检测|告警)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/i],
    evidence: '动环告警配置截图 + 现场模拟测试记录',
    advice: '部署漏水检测绳/传感器并接入动环，做一次模拟漏水告警测试。',
  },
  {
    key: 'access_control',
    label: '门禁 / 出入控制',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['门禁系统', '门禁', '出入控制', '双人授权', '生物识别'],
    patterns: [/(?:门禁|出入控制)(?:系统)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/i],
    evidence: '门禁系统截图 + 出入记录导出',
    advice: '部署门禁并配置权限分级/双人授权，保留至少 90 天出入记录。',
  },
  {
    key: 'cctv',
    label: '视频监控',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['视频监控', 'CCTV', '监控摄像头', '录像存储'],
    patterns: [/(?:视频监控|CCTV|摄像头)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/i],
    evidence: '监控系统截图 + 存储周期配置',
    advice: '补齐摄像头覆盖与录像存储（建议 ≥90 天），并提供回放测试记录。',
  },
  {
    key: 'lightning_protection',
    label: '防雷 / 浪涌保护',
    category: 'datacenter',
    type: 'boolean',
    aliases: ['防雷', '浪涌保护', 'SPD', '防雷接地'],
    patterns: [/(?:防雷|浪涌保护|SPD)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/i],
    evidence: '防雷检测报告 + SPD 配置照片',
    advice: '补充 SPD 与防雷检测，取得年度防雷检测报告。',
  },
  {
    key: 'pue',
    label: 'PUE',
    category: 'datacenter',
    type: 'number',
    unit: '',
    aliases: ['PUE', '能源使用效率', '能效比'],
    patterns: [/PUE\s*[:：=]?\s*(\d(?:\.\d+)?)/i],
    evidence: '动环/电表连续计量数据',
    advice: '优化制冷与配电损耗，提供连续 30 天 PUE 计量数据而非估算值。',
  },

  // ------------------------------------------------------------- 集群与网络
  {
    key: 'network_bandwidth',
    label: '网络带宽',
    category: 'cluster',
    type: 'number',
    unit: 'Gbps',
    units: ['Gbps', 'Gb/s', 'GE', 'Mbps', '100G', '200G', '400G'],
    aliases: ['网络带宽', '链路带宽', '上联带宽', '出口带宽', '参数面带宽', '业务面带宽', '互联带宽'],
    patterns: [/(?:网络|链路|上联|出口|参数面|业务面|互联)带宽\s*[:：=]?\s*(\d{1,5}(?:\.\d+)?)\s*(Gbps|Gb\/s|GE|Mbps)?/i],
    evidence: 'iperf3 / perftest 测试报告 + 交换机端口速率',
    advice: '核查交换机端口、光模块与线缆规格，补做双向带宽测试并附测试命令输出。',
  },
  {
    key: 'network_redundancy',
    label: '网络冗余',
    category: 'cluster',
    type: 'boolean',
    aliases: ['网络冗余', '双上联', '链路冗余', '交换机堆叠', 'M-LAG', '双归接入', '双上联冗余'],
    patterns: [/(?:网络|链路)(?:冗余|双上联|双归)|双上联(?:冗余)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9+-]{1,16})/i],
    evidence: '组网图 + 主备切换测试记录',
    advice: '完成双上联/M-LAG 配置，并做一次链路故障切换测试，记录中断时间。',
  },
  {
    key: 'switch_config',
    label: '交换机型号 / 配置',
    category: 'cluster',
    type: 'string',
    aliases: ['交换机型号', '交换机配置', '核心交换机', 'Leaf交换机', 'Spine交换机', '交换机数量'],
    patterns: [/(?:交换机)(?:型号|配置|数量)?\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 ./-]{2,64})/i],
    evidence: '交换机清单 + 配置文件备份',
    advice: '补充交换机型号、数量与配置备份，确认与组网设计一致。',
  },
  {
    key: 'storage',
    label: '存储配置',
    category: 'cluster',
    type: 'string',
    aliases: ['存储配置', '并行文件系统', '对象存储', '存储容量', 'NAS', 'OBS', 'Lustre', 'OceanStor'],
    patterns: [/(?:存储|并行文件系统|对象存储)(?:配置|容量)?\s*[:：=]?\s*([A-Za-z0-9\u4e00-\u9fa5 .%/+-]{2,64})/i],
    evidence: '存储清单 + 挂载/性能测试记录',
    advice: '补充存储容量、协议与性能测试（IOPS/吞吐/时延）证据。',
  },
  {
    key: 'monitoring',
    label: '监控告警平台',
    category: 'cluster',
    type: 'boolean',
    aliases: ['监控平台', '监控告警', 'Prometheus', 'Grafana', '动环监控', '告警平台', '监控'],
    patterns: [/(?:监控|告警)(?:平台|系统|配置)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,16})/i],
    evidence: '监控大盘截图 + 告警规则/通知渠道配置',
    advice: '接入 NPU、节点、网络与动环监控，配置分级告警与通知渠道，并做一次告警触发测试。',
  },
  {
    key: 'ntp',
    label: 'NTP / 时间同步',
    category: 'cluster',
    type: 'boolean',
    aliases: ['NTP', '时间同步', '时钟同步', 'chrony'],
    patterns: [/(?:NTP|时间同步|时钟同步|chrony)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9:._-]{1,32})/i],
    evidence: 'chronyc sources -v / ntpq -p',
    advice: '配置 NTP/chrony 并确认所有节点与基准源同步，偏差建议 <100ms。',
  },
  {
    key: 'ip_plan',
    label: 'IP / 地址规划',
    category: 'cluster',
    type: 'boolean',
    aliases: ['IP规划', 'IP地址规划', '地址规划', 'IP地址表', '网段规划'],
    patterns: [/(?:IP|地址|网段)规划\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9 ./_-]{1,48})/i],
    evidence: 'IP 规划表 + 交换机/主机配置核对',
    advice: '补齐 IP 规划表并标注管理面、业务面、参数面地址，避免与现网冲突。',
  },
  {
    key: 'firewall_security',
    label: '防火墙 / 安全策略',
    category: 'cluster',
    type: 'boolean',
    aliases: ['防火墙', '安全策略', '访问控制策略', '等保', '安全加固'],
    patterns: [/(?:防火墙|安全策略|等保|安全加固)\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,24})/i],
    evidence: '安全策略清单 + 等保测评/加固报告',
    advice: '按最小权限原则收敛策略，补齐等保测评或安全加固报告。',
  },

  // ------------------------------------------------------------- 交付文档
  {
    key: 'doc_acceptance',
    label: '到货验收单',
    category: 'docs',
    type: 'presence',
    aliases: ['到货验收单', '到货验收记录', '开箱验收单', '验收单'],
    patterns: [],
    evidence: '双方签字盖章的到货验收单（含序列号）',
    advice: '补齐双方签字盖章的到货验收单，并核对设备序列号与资产清单。',
  },
  {
    key: 'doc_packing',
    label: '装箱单',
    category: 'docs',
    type: 'presence',
    aliases: ['装箱单', '发货清单', '包装清单'],
    patterns: [],
    evidence: '随箱装箱单/发货清单',
    advice: '补齐装箱单，确保型号、数量、序列号与实物一一对应。',
  },
  {
    key: 'doc_factory_report',
    label: '出厂检测报告',
    category: 'docs',
    type: 'presence',
    aliases: ['出厂检测报告', '出厂测试报告', '出厂检验报告', '工厂测试报告'],
    patterns: [],
    evidence: '原厂出具的出厂检测报告（含测试项与结论）',
    advice: '向原厂索取覆盖本批次序列号的出厂检测报告。',
  },
  {
    key: 'doc_certificate',
    label: '合格证',
    category: 'docs',
    type: 'presence',
    aliases: ['合格证', '产品合格证', '出厂合格证', '3C证书'],
    patterns: [],
    evidence: '产品合格证/3C 证书',
    advice: '补齐产品合格证或 3C 证书扫描件。',
  },
  {
    key: 'doc_warranty',
    label: '保修卡 / 质保函',
    category: 'docs',
    type: 'presence',
    aliases: ['保修卡', '质保函', '保修凭证', '质保承诺函'],
    patterns: [],
    evidence: '原厂保修卡或盖章质保函',
    advice: '补齐原厂保修卡/质保函，并确认起保日期与质保年限。',
  },
  {
    key: 'doc_asset',
    label: '资产 / 设备清单',
    category: 'docs',
    type: 'presence',
    aliases: ['资产清单', '设备清单', '设备台账', '序列号清单', 'SN清单'],
    patterns: [],
    evidence: '含型号、SN、机柜/U 位的资产清单',
    advice: '补齐含序列号、机柜位置、U 位的资产清单，并与实物核对。',
  },
  {
    key: 'doc_topology',
    label: '网络 / 组网拓扑图',
    category: 'docs',
    type: 'presence',
    aliases: ['网络拓扑图', '组网拓扑图', '拓扑图', '组网图', '逻辑拓扑'],
    patterns: [],
    evidence: '标注链路速率与互联端口的组网拓扑图',
    advice: '补齐标注设备、端口、速率与冗余链路的组网拓扑图。',
  },
  {
    key: 'doc_manual',
    label: '操作 / 维护手册',
    category: 'docs',
    type: 'presence',
    aliases: ['操作手册', '用户手册', '维护手册', '管理员手册', '使用说明书'],
    patterns: [],
    evidence: '中文操作/维护手册（含故障处理章节）',
    advice: '补齐中文操作与维护手册，至少覆盖启停、巡检、常见故障处理。',
  },
  {
    key: 'doc_asbuilt',
    label: '竣工文档 / 图纸',
    category: 'docs',
    type: 'presence',
    aliases: ['竣工图', '竣工文档', '竣工资料', '施工图', '机房平面图'],
    patterns: [],
    evidence: '盖章竣工图（含机柜/配电/网络/接地）',
    advice: '补齐盖章竣工图与竣工资料，确保与现场实际一致。',
  },
  {
    key: 'doc_test_report',
    label: '测试 / 性能报告',
    category: 'docs',
    type: 'presence',
    aliases: ['测试报告', '性能测试报告', '验收测试报告', '基准测试报告', '压测报告'],
    patterns: [],
    evidence: '含测试环境、工具、用例、原始数据与结论的测试报告',
    advice: '补齐覆盖算力、网络、存储与稳定性的测试报告，并附原始数据。',
  },
  {
    key: 'doc_training',
    label: '培训记录',
    category: 'docs',
    type: 'presence',
    aliases: ['培训记录', '培训签到表', '培训材料', '培训计划'],
    patterns: [],
    evidence: '培训签到表、课件与考核记录',
    advice: '补齐培训签到、课件与考核记录，明确培训对象与课时。',
  },
  {
    key: 'doc_cutover',
    label: '割接 / 实施方案',
    category: 'docs',
    type: 'presence',
    aliases: ['割接方案', '实施方案', '上线方案', '迁移方案', '回退方案'],
    patterns: [],
    evidence: '含步骤、窗口、回退预案的割接方案',
    advice: '补齐割接/实施方案与回退预案，并保留割接当天的操作记录。',
  },
  {
    key: 'doc_ip_plan',
    label: 'IP 规划表',
    category: 'docs',
    type: 'presence',
    aliases: ['IP规划表', 'IP地址表', '地址分配表', 'IP地址规划表', 'IP规划'],
    patterns: [],
    evidence: '含管理/业务/参数面地址的 IP 规划表',
    advice: '补齐 IP 规划表，并与交换机、主机实际配置交叉核对。',
  },

  // ---------------------------------------------------------------- 运维
  {
    key: 'warranty_years',
    label: '质保期',
    category: 'ops',
    type: 'number',
    unit: '年',
    units: ['年', '个月', '月'],
    aliases: ['质保期', '保修期', '质量保证期', '免费保修期'],
    patterns: [/(?:质保期|保修期|质量保证期|免费保修期)\s*[:：=]?\s*(\d{1,2})\s*(年|个月|月)?/i],
    evidence: '合同/质保函中的质保条款',
    advice: '按合同延长质保期或补充原厂质保函，明确起止日期与范围。',
  },
  {
    key: 'support_response',
    label: '故障响应时间',
    category: 'ops',
    type: 'number',
    unit: '小时',
    units: ['小时', 'h', '分钟', 'min'],
    aliases: ['响应时间', '故障响应时间', '服务响应时间', '到场时间', '故障到场时间'],
    patterns: [/(?:响应|到场)时间\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*(小时|h|分钟|min)?/i],
    evidence: 'SLA/服务承诺函 + 工单系统记录',
    advice: '将响应时效写入 SLA 并配置 7×24 服务台；提供近期工单响应记录佐证。',
  },
  {
    key: 'spare_parts',
    label: '备品备件',
    category: 'ops',
    type: 'boolean',
    aliases: ['备品备件', '备件库', '备件清单', '备件保障', '备件'],
    patterns: [/(?:备品备件|备件)(?:清单|库|保障)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,24})/i],
    evidence: '备件清单 + 备件库现场照片/位置',
    advice: '按设备规模配置备件（至少 NPU、光模块、电源、风扇），并明确存放地点与调用流程。',
  },
  {
    key: 'inspection',
    label: '巡检服务',
    category: 'ops',
    type: 'boolean',
    aliases: ['定期巡检', '巡检服务', '巡检计划', '巡检报告', '巡检'],
    patterns: [/(?:巡检)(?:服务|计划|报告|周期)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,24})/i],
    evidence: '巡检计划 + 最近一期巡检报告',
    advice: '明确巡检周期、检查项与报告模板，并提供最近一期巡检记录。',
  },
  {
    key: 'onsite_support',
    label: '驻场 / 7×24 支持',
    category: 'ops',
    type: 'boolean',
    aliases: ['驻场服务', '7×24支持', '7*24支持', '驻场运维', '现场支持'],
    patterns: [/(?:驻场|7×24|7\*24)(?:服务|支持|运维)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,24})/i],
    evidence: '服务方案 + 驻场人员名单/排班表',
    advice: '按合同配置驻场或 7×24 支持，提交人员名单、排班与升级路径。',
  },
  {
    key: 'sla',
    label: 'SLA / 服务级别',
    category: 'ops',
    type: 'presence',
    aliases: ['SLA', '服务级别协议', '服务承诺', '服务方案'],
    patterns: [],
    evidence: '双方签署的 SLA 或服务承诺函',
    advice: '补齐签署的 SLA，明确可用性、响应/恢复时间与违约条款。',
  },
  {
    key: 'training_ops',
    label: '培训服务',
    category: 'ops',
    type: 'boolean',
    aliases: ['培训服务', '现场培训', '运维培训', '培训'],
    patterns: [/(?:培训)(?:服务|计划|记录)?\s*[:：=]?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,24})/i],
    evidence: '培训签到表 + 课件 + 考核结果',
    advice: '完成运维培训并提交签到表、课件与考核结果。',
  },
];

export const METRIC_MAP = new Map(METRICS.map((metric) => [metric.key, metric]));

/** 给指标补充默认展示字段。 */
for (const metric of METRICS) {
  metric.categoryLabel = CATEGORY_MAP.get(metric.category)?.label ?? '其他要求';
  metric.commands = metric.commands ?? [];
}

/**
 * 在文本中匹配指标。返回得分最高的候选。
 *
 * 打分原则：完整标签 > 长别名包含 > 短别名包含 > 正则命中。类别提示只在
 * 分数接近时用于打破平局，避免“机房温度”被误判成 NPU 温度。
 *
 * @param {string} text - 指标名/标题/一行文本。
 * @param {'ascend'|'datacenter'|'cluster'|'docs'|'ops'|'other'} [hintCategory] - 类别提示。
 * @returns {{metric: object, score: number, alias: string, captured?: string} | null}
 */
export function matchMetric(text, hintCategory) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return null;
  const normalized = normalizeForMatch(raw);
  let best = null;

  for (const metric of METRICS) {
    let score = 0;
    let matchedAlias = '';
    for (const alias of metric.aliases) {
      const normalizedAlias = normalizeForMatch(alias);
      if (normalizedAlias === '') continue;
      if (normalized === normalizedAlias) {
        if (score < 160) {
          score = 160;
          matchedAlias = alias;
        }
        continue;
      }
      if (normalized.includes(normalizedAlias)) {
        // 长别名更可信；2 个汉字的别名容易撞车，要求更长或类别一致。
        const length = normalizedAlias.length;
        const aliasScore = 70 + Math.min(60, length * 4);
        if (aliasScore > score) {
          score = aliasScore;
          matchedAlias = alias;
        }
      }
    }
    for (const pattern of metric.patterns ?? []) {
      pattern.lastIndex = 0;
      const match = pattern.exec(raw);
      if (match !== null) {
        const patternScore = 130;
        if (patternScore > score) {
          score = patternScore;
          matchedAlias = match[0].slice(0, 40);
        }
      }
    }
    if (score === 0) continue;
    if (hintCategory !== undefined && hintCategory !== 'other' && metric.category === hintCategory) score += 8;
    if (best === null || score > best.score) {
      best = { metric, score, alias: matchedAlias };
    }
  }

  // 短别名（如“湿度”“备件”）单独出现时，只有类别一致才接受，避免误配。
  if (best !== null && best.score < 90 && hintCategory !== undefined && best.metric.category !== hintCategory) return null;
  return best;
}

/** 只按类别找候选指标（用于没有明确指标名的条款）。 */
export function metricsByCategory(category) {
  return METRICS.filter((metric) => metric.category === category);
}

/** 把目录压缩成前端可展示的统计。 */
export function catalogSummary() {
  const counts = {};
  for (const metric of METRICS) counts[metric.category] = (counts[metric.category] ?? 0) + 1;
  return {
    metrics: METRICS.length,
    categories: CATEGORIES.map((category) => ({ ...category, metrics: counts[category.key] ?? 0 })),
  };
}

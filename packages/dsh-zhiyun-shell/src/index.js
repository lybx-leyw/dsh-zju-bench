// 壳（界面外观）的宿主半边：**空的**。
//
// 这不是疏忽。客户端插件的启动图谱由宿主 Loader 的条目合成（ClientModuleRegistry
// 遍历 `ctx.loader.entries()`），没有宿主入口的包根本不会被扫描，`dsh.client`
// 声明也就永远不会被读到 —— 所以纯界面包也必须作为 Loader entry 存在，
// 只是宿主侧没有任何事可做（渲染、样式、插槽注册全在 src/client.jsx 的客户端生命周期里）。
//
// 学习空间的建立**不在**这里：那是「这个产品有一个固定的学习空间」这件事，
// 属于领域，已经搬进 dsh-zhiyun-study-core（见其 src/host.js）。
export const name = 'zhiyun-shell';

export function apply() {}

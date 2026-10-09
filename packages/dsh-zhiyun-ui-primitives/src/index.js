// 共享 UI 原语的宿主半边：本包只在浏览器里渲染，宿主侧没有行为。
//
// 但它**必须**作为 Loader entry 存在：客户端的启动图谱由宿主 Loader 的条目
// 合成（见 dsh-client-modules 的 ClientModuleRegistry），没有宿主入口的包
// 不会被扫描，它的 dsh.client 声明也就不会进图谱。
export const name = 'zhiyun-ui-primitives';

/** 无宿主行为：这个包只在客户端渲染。 */
export function apply() {}

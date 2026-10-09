// 今天页的宿主半边：页面只在浏览器里渲染，宿主侧没有行为。
// 保留 Loader entry 是为了让客户端 bundle 进入启动图谱。
export const name = 'zhiyun-page-today';

/** 无宿主行为：页面内容全部在客户端。 */
export function apply() {}

// Test-only provider. Never included in the product profile.
window.__ModuleLoader__.load({ id: 'zhiyun-test-course-panel', factory: require => {
  const React = require('react');
  return {
    inject: ['slots', 'zhiyunNavigation'],
    apply(ctx) {
      ctx.slots.inject('zhiyun.courses.content', () => ctx.slots.register({ name: 'zhiyun.courses.content' }, () => React.createElement('section', { 'data-test-course-provider': true },
        React.createElement('h1', null, '测试课程扩展已接入'),
        React.createElement('button', { onClick: () => ctx.zhiyunNavigation.navigate('today') }, '返回今天'),
      )));
    },
  };
} });

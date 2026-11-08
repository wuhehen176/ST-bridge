const { Panel } = require('./panel.js')

module.exports = {
  inject: ['slots', 'connection'],
  apply(ctx) {
    const rpcCall = (endpoint, payload) => ctx.connection.rpc.call('/st-bridge', endpoint, payload)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'st-bridge',
      order: 58,
      label: () => 'ST-bridge',
      inject: () => ({ rpcCall }),
    }, Panel))
  },
}

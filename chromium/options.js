const $ = selector => document.querySelector(selector)
function show(settings = {}) {
  $('#theme').value = settings.theme === 'dark' ? 'dark' : 'blue-grey'
  $('#density').value = ['compact', 'comfortable'].includes(settings.density)
    ? settings.density
    : 'default'
  $('#custom-css').value = typeof settings.customCSS === 'string' ? settings.customCSS : ''
  document.documentElement.dataset.theme = $('#theme').value
}
async function save(settings) {
  await chrome.storage.local.set({ chromiumSettings: settings })
  show(settings)
  $('#status').textContent = '已保存，侧边栏已更新'
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await save({
      theme: $('#theme').value,
      density: $('#density').value,
      customCSS: $('#custom-css').value,
    })
  } catch (error) {
    $('#status').textContent = `保存失败：${error.message}`
  }
})
$('#reset').addEventListener('click', async () => {
  if (!confirm('恢复默认外观并清空自定义 CSS？标签和快照不会改变。')) return
  try {
    await save({ theme: 'blue-grey', density: 'default', customCSS: '' })
  } catch (error) {
    $('#status').textContent = `保存失败：${error.message}`
  }
})
chrome.storage.local
  .get('chromiumSettings')
  .then(stored => show(stored.chromiumSettings))
  .catch(error => {
    $('#status').textContent = `读取失败：${error.message}`
  })

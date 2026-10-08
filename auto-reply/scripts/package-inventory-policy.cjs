module.exports.assertPackageInventory = function assertPackageInventory(paths) {
  const allowed = new Set(['out', 'resources', 'node_modules', 'package.json', 'LICENSE', 'NOTICE'])
  for (const name of paths) {
    const path = name.replaceAll('\\', '/').replace(/^\//, '')
    if (!allowed.has(path.split('/')[0]) || /(^|\/)(\.env(\.[^/]*)?|\.npmrc)$/.test(path))
      throw new Error('private_build_files_in_package')
  }
}

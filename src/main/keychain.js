'use strict'
// macOS Keychain via the built-in `security` CLI.
// trade-off: no native keytar dependency — the OS already ships a credential store.
const { execFile } = require('node:child_process')

const SERVICE = 'Gonds'
const SEC = '/usr/bin/security'

function run (args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(SEC, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }))
      resolve(stdout)
    })
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

/** Store (or replace) a secret for `account`. */
async function setPassword (account, secret) {
  if (!account) throw new Error('keychain: account required')
  // -U updates in place; -w via stdin keeps the secret out of the process table.
  await run(['add-generic-password', '-s', SERVICE, '-a', account, '-U', '-w'], secret)
  return true
}

/** Returns the secret, or null when nothing is stored. */
async function getPassword (account) {
  try {
    const out = await run(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return out.replace(/\n$/, '')
  } catch (err) {
    if (/could not be found/i.test(err.stderr || '')) return null
    throw err
  }
}

async function deletePassword (account) {
  try {
    await run(['delete-generic-password', '-s', SERVICE, '-a', account])
    return true
  } catch (err) {
    if (/could not be found/i.test(err.stderr || '')) return false
    throw err
  }
}

module.exports = { setPassword, getPassword, deletePassword }

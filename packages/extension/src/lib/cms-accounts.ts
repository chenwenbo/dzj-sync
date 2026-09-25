/**
 * 自建站账户（WordPress / Typecho / MetaWeblog）存储
 * 账户信息与密码分开保存在 chrome.storage.local
 */
import * as wordpressAdapter from '../adapters/cms/wordpress'
import * as metaweblogAdapter from '../adapters/cms/metaweblog'

export type CMSType = 'wordpress' | 'typecho' | 'metaweblog'

export interface CMSAccount {
  id: string
  type: CMSType
  name: string
  url: string
  username: string
}

const ACCOUNTS_KEY = 'cmsAccounts'
const passwordKey = (id: string) => `cms_pwd_${id}`

export async function getCmsAccounts(): Promise<CMSAccount[]> {
  const storage = await chrome.storage.local.get(ACCOUNTS_KEY)
  return (storage[ACCOUNTS_KEY] as CMSAccount[] | undefined) || []
}

export async function getCmsPassword(id: string): Promise<string | null> {
  const key = passwordKey(id)
  const storage = await chrome.storage.local.get(key)
  return (storage[key] as string | undefined) ?? null
}

export async function testCmsConnection(
  type: CMSType,
  credentials: { url: string; username: string; password: string }
): Promise<{ success: boolean; error?: string }> {
  switch (type) {
    case 'wordpress':
      return wordpressAdapter.testConnection(credentials)
    case 'typecho':
      return metaweblogAdapter.testTypechoConnection(credentials)
    case 'metaweblog':
      return metaweblogAdapter.testConnection(credentials)
  }
}

/**
 * 测试连接成功后保存账户
 */
export async function addCmsAccount(
  input: Omit<CMSAccount, 'id'> & { password: string }
): Promise<{ success: boolean; error?: string }> {
  const { password, ...account } = input
  const test = await testCmsConnection(account.type, { url: account.url, username: account.username, password })
  if (!test.success) {
    return { success: false, error: test.error || '连接失败' }
  }

  const id = `cms_${Date.now()}`
  const accounts = await getCmsAccounts()
  await chrome.storage.local.set({
    [ACCOUNTS_KEY]: [...accounts, { ...account, id }],
    [passwordKey(id)]: password,
  })
  return { success: true }
}

export async function removeCmsAccount(id: string): Promise<void> {
  const accounts = await getCmsAccounts()
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts.filter(a => a.id !== id) })
  await chrome.storage.local.remove(passwordKey(id))
}

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getTemplateDirectory, renderTemplate } from './utils'

const builtInTemplates = [
  'common',
  'code/base',
  'config/ts',
  'config/eslint',
]

export interface ProjectOptions {
  path: string
  name: string
  templateDir: string

  templates: string[]
}

export function createProjectOptions(params: Pick<ProjectOptions, 'path' | 'name' | 'templateDir'>): ProjectOptions {
  return {
    ...params,
    templates: [],
  }
}

export async function createProject(options: ProjectOptions) {
  const templateDirectory = (await getTemplateDirectory())!
  const withBase = (path: string) => join(templateDirectory, path)

  await mkdir(options.path)
  await writeFile(join(options.path, 'package.json'), JSON.stringify({
    name: options.name,
  }, null, 2))

  for (const template of [
    ...builtInTemplates,
    ...options.templates,
  ]) {
    await renderTemplate(withBase(template), options.path)
  }
}

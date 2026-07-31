import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typedRules = {
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/require-await': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-misused-promises': 'warn',
    '@typescript-eslint/no-unsafe-enum-comparison': 'warn',
    '@typescript-eslint/no-floating-promises': 'warn',
    '@typescript-eslint/unbound-method': 'warn',
    '@typescript-eslint/no-unused-vars': [
        'warn',
        {
            args: 'all',
            argsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            ignoreRestSiblings: true
        }
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-redeclare': 'error',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error'
}

export default tseslint.config(
    {
        ignores: ['**/dist/**', '**/*.d.ts', 'eslint.config.js', '.prettierrc.cjs']
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: {allowDefaultProject: ['scripts/*.mjs']},
                tsconfigRootDir: import.meta.dirname
            }
        }
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: { ...globals.node }
        },
        rules: typedRules
    },
    {
        ...tseslint.configs.disableTypeChecked,
        files: ['scripts/*.mjs'],
        languageOptions: {
            ...tseslint.configs.disableTypeChecked.languageOptions,
            globals: {...globals.node}
        }
    }
)

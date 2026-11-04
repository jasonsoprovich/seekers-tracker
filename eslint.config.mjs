import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
	...nextVitals,
	...nextTs,
	{
		ignores: [".next/**", ".open-next/**", ".wrangler/**", "node_modules/**", "cloudflare-env.d.ts"],
	},
];

export default eslintConfig;

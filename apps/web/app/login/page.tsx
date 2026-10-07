import { AccountForm } from "../../components/mobile/account.js";
export default function LoginPage() {
  return (
    <main className="mobile-login">
      <p>FAMILY ALBUM</p>
      <h1>嘟嘟家庭相册</h1>
      <p>登录后查看私密家庭相册。</p>
      <AccountForm />
    </main>
  );
}

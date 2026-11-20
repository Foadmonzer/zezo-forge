import { PlatformShell } from './platform/shell';

export default function NotFound() {
  return <PlatformShell>
    <section className="zf-wrap zf-not-found" aria-labelledby="not-found-title">
      <h1 id="not-found-title">الصفحة غير موجودة</h1>
      <p lang="en" dir="ltr">This page could not be found.</p>
      <div><a className="zf-button zf-button--primary" href="/">الرئيسية</a>
        <a className="zf-button" href="/?lang=en" lang="en">Home in English</a></div>
    </section>
  </PlatformShell>;
}

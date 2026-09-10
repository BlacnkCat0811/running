// 网站备案号悬挂：依据工信部要求，页面底部需展示 ICP 备案号并链接至 beian.miit.gov.cn。
// 备案号格式为「省份简称 + ICP备 + 序列号」，此处为广东省主体备案下的第 1 个网站。
const ICP_LICENSE = "粤ICP备2026134468号-1";
const ICP_LICENSE_URL = "https://beian.miit.gov.cn/";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href={ICP_LICENSE_URL} target="_blank" rel="noopener noreferrer">
        {ICP_LICENSE}
      </a>
    </footer>
  );
}

// 网站备案号悬挂：依据工信部与公安部要求，页面底部需同时展示 ICP 备案号与公安联网备案号。
// 两者互相独立，缺一即核查不通过，所以它们必须一起出现在每个渲染分支里。
//
// ICP 备案号格式「省份简称 + ICP备 + 序列号」，链接至 beian.miit.gov.cn。
const ICP_LICENSE = "粤ICP备2026134468号-1";
const ICP_LICENSE_URL = "https://beian.miit.gov.cn/";

// 公安联网备案号格式「省份简称 + 公网安备 + 属地代码(6) + 标注位(2) + 顺序码(6)」，
// 此处 440118 为广州市增城区、02 为标注位。链接是平台查询页，code 参数即纯数字备案号。
// 号码只写一次：展示文本与链接的 code 都由它派生，避免改一处忘一处。
const POLICE_LICENSE_CODE = "44011802001569";
const POLICE_LICENSE = `粤公网安备${POLICE_LICENSE_CODE}号`;
const POLICE_LICENSE_URL = `https://beian.mps.gov.cn/#/query/webSearch?code=${POLICE_LICENSE_CODE}`;
// 图标由全国互联网安全管理服务平台「点击下载备案编号图标」取得，置于备案编号之前。
const POLICE_LICENSE_ICON = "/assets/gongan-beian.png";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href={ICP_LICENSE_URL} target="_blank" rel="noopener noreferrer">
        {ICP_LICENSE}
      </a>
      <a
        className="site-footer-police"
        href={POLICE_LICENSE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <img src={POLICE_LICENSE_ICON} alt="" />
        <span>{POLICE_LICENSE}</span>
      </a>
    </footer>
  );
}

import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export default function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="bg-background flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">{t("notFound.title")}</p>
      <Link to="/app" className="text-primary underline underline-offset-4">
        {t("notFound.goToApp")}
      </Link>
    </div>
  );
}

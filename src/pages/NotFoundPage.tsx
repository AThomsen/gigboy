import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function NotFoundPage() {
  useDocumentTitle('Page not found');

  return (
    <div className="app-status" role="alert">
      <BrandLogo size={72} />
      <h1>Page not found</h1>
      <p>The page you're looking for doesn't exist or may have moved.</p>
      <Link to="/" className="btn btn--primary" style={{ marginTop: '1rem' }}>
        Go to Gigboy
      </Link>
    </div>
  );
}

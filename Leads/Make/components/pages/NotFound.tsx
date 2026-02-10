import { Link } from "react-router";
import { Button } from "../ui/button";

export function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <h2 className="text-2xl mb-4">404 - Page Not Found</h2>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
